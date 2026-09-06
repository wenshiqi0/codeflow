import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTeamBashOperations } from "../../runtime/extensions/team-shell";
import { listTeamTools, reapTeamTools } from "../../runtime/lib/team-tools";
import { RunPaths } from "../../runtime/lib/paths";

const fixtures: Array<{ dir: string; paths: RunPaths }> = [];
afterEach(async () => {
	for (const f of fixtures.splice(0)) {
		try { await reapTeamTools(f.paths, "exec-shell"); }
		finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
	}
});
function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-team-shell-"));
	const paths = new RunPaths(path.join(dir, "runs"), "task-shell");
	fixtures.push({ dir, paths }); return { dir, paths, operations: createTeamBashOperations(paths, "exec-shell") };
}
function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}
describe("outer-recoverable shell operations", () => {
	test("native bash command semantics, stderr, exit status, and cleanup are retained", async () => {
		const f = fixture(); let output = "";
		const result = await f.operations.exec('printf "stdout\\n"; printf "stderr\\n" >&2; exit 7', f.dir, { onData: chunk => { output += chunk; } });
		expect(result.exitCode).toBe(7); expect(output).toContain("stdout"); expect(output).toContain("stderr");
		expect(listTeamTools(f.paths, "exec-shell")).toEqual([]);
	});
	test("command output is impossible before durable PID publication, without recording command text", async () => {
		const f = fixture(); let sawRegistered = false;
		await f.operations.exec('printf "private-marker"', f.dir, { onData: () => {
			const records = listTeamTools(f.paths, "exec-shell");
			sawRegistered ||= records.length === 1;
			expect(JSON.stringify(records)).not.toContain("private-marker");
			expect(Object.keys(records[0]).sort()).toEqual(["execution_id", "pgid", "pid", "process_started_at", "schema_version", "tool_id"]);
		} });
		expect(sawRegistered).toBe(true);
	});
	test("normal command completion also reaps background descendants before returning", async () => {
		const f = fixture(); let output = "";
		await f.operations.exec('sleep 60 & printf "%s\\n" "$!"', f.dir, { onData: chunk => { output += chunk; } });
		const pid = Number(output.trim()); expect(pid).toBeGreaterThan(1); expect(alive(pid)).toBe(false);
		expect(listTeamTools(f.paths, "exec-shell")).toEqual([]);
	});
	test("timeout and caller abort both reclaim the full owned group", async () => {
		const f = fixture();
		await expect(f.operations.exec("sleep 60", f.dir, { timeout: 0.05, onData() {} })).rejects.toThrow("timeout:0.05");
		expect(listTeamTools(f.paths, "exec-shell")).toEqual([]);
		const controller = new AbortController(); let output = "";
		await expect(f.operations.exec('printf "%s\\n" "$$"; sleep 60', f.dir, { signal: controller.signal, onData: chunk => {
			output += chunk; controller.abort();
		} })).rejects.toThrow("aborted");
		expect(alive(Number(output.trim()))).toBe(false);
		expect(listTeamTools(f.paths, "exec-shell")).toEqual([]);
	});
	test("rapid cancelled launches keep output isolated from the completion channel", async () => {
		const f = fixture();
		for (let index = 0; index < 12; index++) {
			const controller = new AbortController(); let output = "";
			await expect(f.operations.exec('printf "0\\n" >&2; sleep 60', f.dir, {
				signal: controller.signal, onData: chunk => { output += chunk; controller.abort(); },
			})).rejects.toThrow("aborted");
			expect(output).toBe("0\n");
			expect(listTeamTools(f.paths, "exec-shell")).toEqual([]);
		}
	});
});
