import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorker } from "../../lib/config";
import {
	attachHandoffProcess,
	loadReceipt,
	loadHandoff,
	startHandoff,
	recordRuntimeFailure,
	type RuntimeFailureReason,
} from "../../lib/handoff";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";

const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG_FILE = path.join(RUNTIME_DIR, "config.json");
const CHILD_EXTENSIONS = [
	"provider-profiles",
	"agent-watchdog",
	"codeflow-context",
	"codeflow-protocol",
	"bash-compressor",
	"usage-ledger",
	"host-guard",
].map((name) => path.join(RUNTIME_DIR, "extensions", name, "index.ts"));

export interface WorkerExecution {
	handoff_id: string;
	exit_code: number;
	stop_reason: string | null;
	receipt_id: string | null;
	status: string;
	runtime_failure_reasons: RuntimeFailureReason[];
}

function currentPaths(): RunPaths {
	const taskId = process.env.CODEFLOW_RUN_ID;
	if (!taskId) throw new Error("worker spawn requires a Codeflow task");
	return new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, taskId);
}

function invocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const executable = path.basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable)
		? { command: "pi", args }
		: { command: process.execPath, args };
}

function reasonsFor(result: { exitCode: number; stopReason?: string; aborted: boolean; stderr: string }): RuntimeFailureReason[] {
	const reasons: RuntimeFailureReason[] = [];
	if (result.aborted || result.stopReason === "aborted") reasons.push("USER_CANCELLED");
	if (result.stopReason === "length") reasons.push("OUTPUT_TRUNCATED");
	if (result.stderr.includes("CODEFLOW_EXECUTION_TIMEOUT")) reasons.push("EXECUTION_TIMEOUT");
	if (result.exitCode !== 0 || result.stopReason === "error") reasons.push("PROVIDER_FAILURE");
	return [...new Set(reasons)];
}

export async function spawnWorker(
	handoffId: string,
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<WorkerExecution> {
	const paths = currentPaths();
	const handoff = loadHandoff(paths, handoffId);
	startHandoff(paths, handoffId);
	const resolved = resolveWorker(CONFIG_FILE);
	const args = [
		"--mode", "json",
		"--provider", resolved.provider,
		"--model", resolved.model,
		"--system-prompt", resolved.systemPrompt,
		...CHILD_EXTENSIONS.flatMap((extension) => fs.existsSync(extension) ? ["--extension", extension] : []),
		"--no-context-files",
		"--no-session",
		"-p", "Execute the current Handoff from the injected Codeflow context and submit one Receipt.",
	];
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: RUNTIME_DIR,
		CODEFLOW_PROJECT_DIR: path.resolve(cwd),
		CODEFLOW_HANDOFF_ID: handoffId,
		CODEFLOW_GOAL_ID: handoff.goal_id,
		CODEFLOW_PROCESS_KIND: "worker",
	};
	let buffer = "";
	let stopReason: string | undefined;
	let stderr = "";
	let aborted = false;
	const command = invocation(args);
	const exitCode = await new Promise<number>((resolve) => {
		const child = spawn(command.command, command.args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
		if (child.pid !== undefined) attachHandoffProcess(paths, handoffId, child.pid);
		let closed = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			aborted = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (!closed && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, 5_000);
		};
		const processLine = (line: string) => {
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
					stopReason = event.message.stopReason ?? stopReason;
				}
			} catch {
				// Pi stdout is an event stream; a partial line is handled by the next chunk.
			}
		};
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) processLine(line);
		});
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("error", (error) => { stderr += String(error); });
		child.on("close", (code) => {
			closed = true;
			if (killTimer) clearTimeout(killTimer);
			if (buffer.trim()) processLine(buffer);
			signal?.removeEventListener("abort", stop);
			resolve(code ?? 1);
		});
		if (signal?.aborted) stop();
		else signal?.addEventListener("abort", stop, { once: true });
	});

	const receipt = loadReceipt(paths, handoffId);
	if (receipt) {
		return {
			handoff_id: handoffId,
			exit_code: exitCode,
			stop_reason: stopReason ?? null,
			receipt_id: receipt.id,
			status: receipt.status,
			runtime_failure_reasons: [],
		};
	}
	const reasons = reasonsFor({ exitCode, stopReason, aborted, stderr });
	if (reasons.length === 0) reasons.push("DELEGATION_ARTIFACT_MISSING");
	recordRuntimeFailure(paths, handoffId, reasons, "Worker execution ended without a Receipt");
	return {
		handoff_id: handoffId,
		exit_code: exitCode,
		stop_reason: stopReason ?? null,
		receipt_id: null,
		status: "interrupted",
		runtime_failure_reasons: reasons,
	};
}
