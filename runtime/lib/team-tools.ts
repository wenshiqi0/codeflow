/** Durable process-group ownership only. Never persist commands, output, or env. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { RunPaths } from "./paths";

export interface TeamToolProcess {
	schema_version: 1;
	tool_id: string;
	execution_id: string;
	pid: number;
	pgid: number;
	/** Kernel-reported leader birth fingerprint, not a wall-clock estimate. */
	process_started_at: string;
}

function id(value: string): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("invalid tool execution identity");
	return value;
}
const directory = (paths: RunPaths, executionId: string) => path.join(paths.executions, id(executionId), "tools");
const recordFile = (paths: RunPaths, record: TeamToolProcess) => path.join(directory(paths, record.execution_id), `${id(record.tool_id)}.json`);

function groupExists(pgid: number): boolean {
	try { process.kill(-pgid, 0); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

export function processIdentity(pid: number): { pgid: number; started: string } | null {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) throw new Error("invalid process PID");
	const result = spawnSync("ps", ["-p", String(pid), "-o", "pid=", "-o", "pgid=", "-o", "lstart="], {
		encoding: "utf8", timeout: 1_000, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw new Error("cannot verify tool process identity");
	const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
	if (result.status === 0 && match && Number(match[1]) === pid) return { pgid: Number(match[2]), started: match[3] };
	try { process.kill(pid, 0); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return null; }
	throw new Error("cannot verify live tool process identity");
}

/** Must finish durably before the shell receives even one byte of command. */
export function registerTeamTool(paths: RunPaths, executionId: string, pid: number): TeamToolProcess {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error("invalid tool process PID");
	const current = processIdentity(pid);
	if (!current || current.pgid !== pid) throw new Error("tool must own a live, independent process group");
	const record: TeamToolProcess = { schema_version: 1, tool_id: randomUUID(), execution_id: id(executionId),
		pid, pgid: pid, process_started_at: current.started };
	const dir = directory(paths, executionId);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = recordFile(paths, record);
	const staging = `${target}.${process.pid}.tmp`;
	const descriptor = fs.openSync(staging, "wx", 0o600);
	try {
		fs.writeFileSync(descriptor, JSON.stringify(record) + "\n");
		fs.fsyncSync(descriptor);
	} finally { fs.closeSync(descriptor); }
	fs.renameSync(staging, target);
	return record;
}

export function listTeamTools(paths: RunPaths, executionId: string): TeamToolProcess[] {
	let files: string[];
	try { files = fs.readdirSync(directory(paths, executionId)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	return files.filter(file => file.endsWith(".json")).flatMap(file => {
		let record: TeamToolProcess;
		try { record = JSON.parse(fs.readFileSync(path.join(directory(paths, executionId), file), "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
		if (record.schema_version !== 1 || record.execution_id !== executionId || `${record.tool_id}.json` !== file
			|| !Number.isSafeInteger(record.pid) || record.pid <= 0 || record.pid > 2_147_483_647 || record.pid === process.pid
			|| record.pgid !== record.pid || typeof record.process_started_at !== "string" || !record.process_started_at) {
			throw new Error("malformed tool process ownership record; cleanup is not confirmed");
		}
		return [record];
	});
}

/** Safe to race between Pi shutdown and its outer runner; no Team lock is used. */
export async function reapTeamTool(paths: RunPaths, record: TeamToolProcess): Promise<void> {
	const deadline = Date.now() + 2_000;
	let signalled = false;
	while (groupExists(record.pgid)) {
		const current = processIdentity(record.pid);
		if (current) {
			if (current.pgid !== record.pgid || current.started !== record.process_started_at) {
				throw new Error("tool PID identity changed; refusing to signal a possibly reused process group");
			}
			if (!signalled) {
				try { process.kill(-record.pgid, "SIGKILL"); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
				signalled = true;
			}
		}
		// The group leader is a keeper, alive until cleanup. A missing leader can
		// mean another reaper just killed it; wait, never signal an unverified group.
		if (Date.now() >= deadline) throw new Error("tool process group cleanup is unconfirmed; ownership record retained");
		await Bun.sleep(20);
	}
	try { fs.unlinkSync(recordFile(paths, record)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Call after the Pi execution is stopped/fenced so no new command can launch. */
export async function reapTeamTools(paths: RunPaths, executionId: string): Promise<void> {
	const results = await Promise.allSettled(listTeamTools(paths, executionId).map(record => reapTeamTool(paths, record)));
	const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
	if (failures.length) throw new AggregateError(failures.map(result => result.reason), "tool cleanup failed; Agent must not be reused");
}
