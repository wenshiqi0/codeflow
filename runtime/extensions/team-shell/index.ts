/** Pi's native bash schema/output handling with outer-recoverable process groups. */
import { spawn } from "node:child_process";
import { createBashToolDefinition, type BashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import { registerTeamTool, reapTeamTool, reapTeamTools, type TeamToolProcess } from "../../lib/team-tools";

// The keeper reads no model command before its durable registration gate opens.
// It remains the same verifiable group leader even after the command exits with
// background descendants. The command uses bash -c and /dev/null stdin as Pi did.
// BashOperations already combines stdout/stderr into onData, so merge command
// output on stdout and reserve keeper stderr for the numeric status. Standard
// pipes avoid Bun's extra-fd socket-connection race during rapid cancellation.
const KEEPER = [
	"IFS= read -r __codeflow_start || exit 0",
	"__codeflow_command=$(/bin/cat)",
	'/bin/bash -c "$__codeflow_command" </dev/null 2>&1',
	"__codeflow_status=$?",
	"printf '%s\\n' \"$__codeflow_status\" >&2",
	"while :; do /bin/sleep 3600; done",
].join("\n");

export function createTeamBashOperations(paths: RunPaths, executionId: string): BashOperations {
	return { exec: async (command, cwd, { onData, signal, timeout, env }) => {
		if (process.platform === "win32") throw new Error("outer-managed bash requires POSIX process groups");
		if (signal?.aborted) throw new Error("aborted");
		if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1_000 > 2_147_483_647)) {
			throw new Error("Invalid timeout: must be finite positive seconds within the timer limit");
		}
		const child = spawn("/bin/bash", ["-c", KEEPER], {
			cwd, env: env ?? process.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
		});
		const statusPipe = child.stderr;
		let record: TeamToolProcess | undefined;
		let timedOut = false;
		let statusSeen = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let cleanup: Promise<void> | undefined;
		let statusBuffer = "";
		const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
		const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
		const finished = new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", () => { if (!statusSeen) reject(new Error("shell keeper exited before command completion")); });
			statusPipe.on("data", (data: Buffer) => {
				statusBuffer += data.toString("utf8");
				if (!statusBuffer.includes("\n")) return;
				const value = statusBuffer.trim();
				if (!/^\d{1,3}$/.test(value) || Number(value) > 255) {
					reject(new Error("invalid shell completion status")); return;
				}
				statusSeen = true;
				resolve(Number(value));
			});
		});
		// A registration failure may precede the normal await; consume the error
		// while retaining the same Promise for the execution path below.
		void finished.catch(() => {});
		child.stdout!.on("data", onData);
		child.stdin!.on("error", () => {});
		const interrupt = () => {
			if (record) cleanup ??= reapTeamTool(paths, record);
			else child.kill("SIGKILL"); // No command has been released before registration.
			void cleanup?.catch(() => {});
		};
		try {
			if (!child.pid) throw new Error("shell process could not be launched");
			record = registerTeamTool(paths, executionId, child.pid);
			signal?.addEventListener("abort", interrupt, { once: true });
			if (signal?.aborted) interrupt();
			else {
				if (timeout !== undefined) timeoutHandle = setTimeout(() => { timedOut = true; interrupt(); }, timeout * 1_000);
				child.stdin!.end("start\n" + command);
			}
			try {
				const exitCode = await finished;
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				return { exitCode };
			} catch (error) {
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw error;
			}
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			signal?.removeEventListener("abort", interrupt);
			if (record) await (cleanup ?? reapTeamTool(paths, record));
			else child.kill("SIGKILL");
			await exited;
			child.stdin!.destroy(); statusPipe.destroy();
			await closed;
		}
	} };
}

export default function teamShell(pi: ExtensionAPI): void {
	if (!process.env.CODEFLOW_TEAM_AGENT_ID) return;
	const taskId = process.env.CODEFLOW_RUN_ID;
	const executionId = process.env.CODEFLOW_EXECUTION_ID;
	const cwd = process.env.CODEFLOW_PROJECT_DIR;
	if (!taskId || !executionId || !cwd) throw new Error("Team shell requires an attributed execution");
	const paths = new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, taskId);
	pi.registerTool(createBashToolDefinition(cwd, { operations: createTeamBashOperations(paths, executionId) }));
	process.env.CODEFLOW_TEAM_SHELL_READY = executionId;
	pi.on("session_shutdown", async () => { await reapTeamTools(paths, executionId); });
}
