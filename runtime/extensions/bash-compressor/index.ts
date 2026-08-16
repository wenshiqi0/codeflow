/**
 * Pi extension that asks the internal zipper role to semantically compress
 * oversized bash results. Any failure or timeout keeps the original result.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import { appendUsageRecord, usageRecordFromMessage } from "../../lib/usage";
import {
	type BashToolResultLike,
	handleBashToolResult,
	parseZipperProcessOutput,
	resolveThreshold,
} from "./compressor";

const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ZIPPER_PATH = path.join(RUNTIME_DIR, "agents", "zipper.md");
const PI_PATH = path.join(RUNTIME_DIR, "bin", "pi");
export const ZIPPER_TIMEOUT_MS = 20_000;

interface ZipperRole {
	provider: string;
	model: string;
	systemPrompt: string;
}

let zipperRole: ZipperRole | undefined;

function readZipperRole(): ZipperRole {
	if (zipperRole) return zipperRole;
	const parsed = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(ZIPPER_PATH, "utf8"));
	const binding = String(parsed.frontmatter.model ?? "");
	const separator = binding.indexOf("/");
	if (separator <= 0 || separator === binding.length - 1) {
		throw new Error(`invalid zipper model binding: ${binding}`);
	}
	zipperRole = {
		provider: binding.slice(0, separator),
		model: binding.slice(separator + 1),
		systemPrompt: String(parsed.body),
	};
	return zipperRole;
}

function runZipper(prompt: string, externalSignal?: AbortSignal): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const role = readZipperRole();
		const args = [
			"--mode", "json",
			"--provider", role.provider,
			"--model", role.model,
			"--system-prompt", role.systemPrompt,
			"--no-extensions",
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
						usageRecord.role = "zipper";
						usageRecord.depth = 2;
						appendUsageRecord(
							new RunPaths(
								process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR,
								usageRecord.run_id,
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
