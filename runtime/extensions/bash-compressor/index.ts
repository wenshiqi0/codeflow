/**
 * Pi extension that asks the internal output-compression service to compress
 * oversized bash results. Any failure or timeout keeps the original result.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import { resolveOutputCompression } from "../../lib/config";
import { appendUsageRecord, usageRecordFromMessage } from "../../lib/usage";
import {
	type BashToolResultLike,
	handleBashToolResult,
	parseZipperProcessOutput,
	resolveThreshold,
} from "./compressor";

const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG_FILE = path.join(RUNTIME_DIR, "config.json");
const PI_PATH = path.join(RUNTIME_DIR, "bin", "pi");
const PROVIDER_PROFILES_EXTENSION = path.join(RUNTIME_DIR, "extensions", "provider-profiles", "index.ts");
export const ZIPPER_TIMEOUT_MS = 20_000;

interface CompressionService {
	provider: string;
	model: string;
	systemPrompt: string;
}

let compressionService: CompressionService | undefined;

function readCompressionService(): CompressionService {
	if (compressionService) return compressionService;
	const resolved = resolveOutputCompression(CONFIG_FILE);
	compressionService = {
		provider: resolved.provider,
		model: resolved.model,
		systemPrompt: resolved.systemPrompt,
	};
	return compressionService;
}

export function runZipper(prompt: string, externalSignal?: AbortSignal): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const service = readCompressionService();
		const args = [
			"--mode", "json",
			"--provider", service.provider,
			"--model", service.model,
			"--system-prompt", service.systemPrompt,
			"--no-extensions",
			"--extension", PROVIDER_PROFILES_EXTENSION,
			"--no-context-files",
			"--no-session",
			"--no-tools",
			"-p", prompt,
		];

		let stdout = "";
		let stderr = "";
		let settled = false;
		const child = spawn(PI_PATH, args, {
			cwd: process.cwd(),
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: RUNTIME_DIR,
				NO_COLOR: "1",
				CI: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		const settle = (error: Error | undefined, value?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			externalSignal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(value ?? "");
		};

		const timeout = setTimeout(() => {
			const error = new Error(`zipper timed out after ${ZIPPER_TIMEOUT_MS}ms`);
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1000).unref();
			settle(error);
		}, ZIPPER_TIMEOUT_MS);

		const onAbort = () => {
			child.kill("SIGTERM");
			settle(new Error("zipper aborted"));
		};
		if (externalSignal?.aborted) {
			onAbort();
			return;
		}
		externalSignal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += chunk;
		});
		child.on("error", (error) => settle(error));
		child.on("close", (code, signal) => {
			if (code === 0) {
				const parsed = parseZipperProcessOutput(stdout);
				if (parsed.message) {
					const usageRecord = usageRecordFromMessage(parsed.message, 1);
					if (usageRecord) {
						usageRecord.worker_kind = "service";
						appendUsageRecord(
							new RunPaths(
								process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR,
								usageRecord.task_id,
							),
							usageRecord,
						);
					}
				}
				if (parsed.text.length > 0) {
					settle(undefined, parsed.text);
				} else {
					settle(new Error("zipper returned empty output"));
				}
			} else {
				settle(
					new Error(
						`zipper exited ${code ?? "unknown"}${signal ? ` (${signal})` : ""}: ${stderr.trim()}`,
					),
				);
			}
		});
	});
}

export default function (pi: ExtensionAPI): void {
	const threshold = resolveThreshold(process.env.CODEFLOW_BASH_COMPRESS_THRESHOLD_BYTES);

	pi.on("tool_result", async (event, ctx) => {
		return await handleBashToolResult(
			event as BashToolResultLike,
			(prompt) => runZipper(prompt, ctx?.signal),
			threshold,
		);
	});
}
