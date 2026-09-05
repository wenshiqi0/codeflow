/** Task-wide process leases: recursion is bounded by resources, never by depth. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { RunPaths, writeJsonAtomic } from "./paths";

export const DEFAULT_MAX_CONCURRENT_AGENTS = 8;
const LOCK_TIMEOUT_MS = 1_000;
const lockSleep = new Int32Array(new SharedArrayBuffer(4));

interface ParentRecord {
	execution_id: string;
	parent_execution_id: string;
}

interface LeaseRecord extends ParentRecord {
	token: string;
	owner_pid: number;
	pid: number | null;
}

function validPid(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export function maxConcurrentAgents(value = process.env.CODEFLOW_MAX_CONCURRENT_AGENTS): number {
	const limit = value === undefined ? DEFAULT_MAX_CONCURRENT_AGENTS : Number(value);
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("CODEFLOW_MAX_CONCURRENT_AGENTS must be a positive integer");
	return limit;
}

function leaseRoot(paths: RunPaths): string { return path.join(paths.runDir, ".agent-slots"); }

/**
 * Serialize every lease mutation, including stale checks and removal. No reader
 * can reclaim a replacement lease using an observation made before this lock.
 * A crashed lock owner fails closed: stealing a lock has the same unsafe race.
 * This bounded metadata critical section never waits for an Agent to finish.
 */
function withLeaseLock<T>(paths: RunPaths, operation: (root: string) => T): T {
	const root = leaseRoot(paths);
	fs.mkdirSync(root, { recursive: true });
	const lock = path.join(root, ".lock");
	const deadline = performance.now() + LOCK_TIMEOUT_MS;
	let descriptor: number;
	while (true) {
		try { descriptor = fs.openSync(lock, "wx"); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (performance.now() >= deadline) {
				throw new Error("Agent capacity metadata is locked. Retry after current Runtime activity; if the lock owner crashed, stop the Task and inspect its capacity metadata before recovery.");
			}
			Atomics.wait(lockSleep, 0, 0, 5);
		}
	}
	try {
		fs.writeFileSync(descriptor, JSON.stringify({ owner_pid: process.pid }));
		return operation(root);
	} finally {
		fs.closeSync(descriptor);
		fs.unlinkSync(lock);
	}
}

function validParent(value: unknown): value is ParentRecord {
	if (value === null || typeof value !== "object") return false;
	const record = value as Partial<ParentRecord>;
	return typeof record.execution_id === "string" && record.execution_id.length > 0
		&& typeof record.parent_execution_id === "string" && record.parent_execution_id.length > 0;
}

function readLease(dir: string): LeaseRecord | null {
	let value: unknown;
	try { value = JSON.parse(fs.readFileSync(path.join(dir, "lease.json"), "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`Agent capacity lease is unreadable: ${dir}`, { cause: error });
	}
	const record = value as Partial<LeaseRecord> | null;
	if (!validParent(value) || !record || typeof record.token !== "string" || record.token.length === 0
		|| !validPid(record.owner_pid) || (record.pid !== null && !validPid(record.pid))) {
		throw new Error(`Agent capacity lease is invalid: ${dir}`);
	}
	return record as LeaseRecord;
}

function readParents(root: string): ParentRecord[] {
	let value: unknown;
	try { value = JSON.parse(fs.readFileSync(path.join(root, "parents.json"), "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (!Array.isArray(value) || !value.every(validParent)) throw new Error("Agent capacity parent index is invalid");
	return value;
}

function readClosed(root: string): Set<string> {
	let value: unknown;
	try { value = JSON.parse(fs.readFileSync(path.join(root, "closed.json"), "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
		throw error;
	}
	if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0)) {
		throw new Error("Agent capacity closed-subtree index is invalid");
	}
	return new Set(value);
}

function assertSubtreeOpen(root: string, executionId: string): void {
	const closed = readClosed(root);
	const parents = new Map(readParents(root).map((record) => [record.execution_id, record.parent_execution_id]));
	const visited = new Set<string>();
	let current: string | undefined = executionId;
	while (current !== undefined) {
		if (closed.has(current)) throw new Error("Agent subtree is closed. Do not delegate more work from this execution.");
		if (visited.has(current)) throw new Error("Agent capacity ancestry contains a cycle");
		visited.add(current);
		current = parents.get(current);
	}
}

/** Fence future spawns before signalling a subtree, including in-flight PID publication. */
export function closeAgentSubtree(paths: RunPaths, executionId: string): void {
	if (!executionId.trim()) throw new Error("Agent execution id must be nonempty");
	withLeaseLock(paths, (root) => {
		const closed = readClosed(root);
		closed.add(executionId);
		writeJsonAtomic(path.join(root, "closed.json"), [...closed]);
	});
}

/** A genuine Child registers itself before any provider request, even if its owner crashed after fork. */
export function validateAgentStartup(paths: RunPaths, executionId: string, pid = process.pid): void {
	if (!executionId.trim() || !validPid(pid)) throw new Error("Agent startup requires an execution id and positive process id");
	withLeaseLock(paths, (root) => {
		const leases = fs.readdirSync(root).filter((name) => /^\d+$/.test(name))
			.map((name) => ({ dir: path.join(root, name), record: readLease(path.join(root, name)) }))
			.filter((entry) => entry.record?.execution_id === executionId);
		if (leases.length !== 1 || leases[0].record === null) {
			throw new Error("Agent startup has no unique capacity lease. Stop this execution and inspect the Task before retrying.");
		}
		const { dir, record } = leases[0] as { dir: string; record: LeaseRecord };
		if (record.pid !== null && record.pid !== pid) throw new Error("Agent startup lease belongs to a different process");
		record.pid = pid;
		writeJsonAtomic(path.join(dir, "lease.json"), record);
		if (!alive(record.owner_pid)) throw new Error("Agent startup owner is no longer alive. Stop this orphaned execution; the Parent must delegate again.");
		assertSubtreeOpen(root, executionId);
	});
}

export interface AgentLease {
	attach(pid: number): void;
	release(): void;
}

/** Reserve a shared slot before spawn; root occupies one slot throughout the Task. */
export function reserveAgentSlot(paths: RunPaths, executionId: string, parentExecutionId: string): AgentLease {
	if (!executionId.trim() || !parentExecutionId.trim() || executionId === parentExecutionId) {
		throw new Error("Agent execution and parent execution ids must be nonempty and distinct");
	}
	const limit = maxConcurrentAgents();
	return withLeaseLock(paths, (root) => {
		assertSubtreeOpen(root, executionId);
		assertSubtreeOpen(root, parentExecutionId);
		for (let slot = 1; slot < limit; slot++) {
			const dir = path.join(root, String(slot));
			if (fs.existsSync(dir)) {
				const prior = readLease(dir);
				// An unattached lease may have spawned just before its owner crashed;
				// no PID means we cannot prove that no orphan is using the slot.
				if (!prior || prior.pid === null || alive(prior.owner_pid) || alive(prior.pid)) continue;
				fs.rmSync(dir, { recursive: true });
			}
			fs.mkdirSync(dir);
			const record: LeaseRecord = {
				execution_id: executionId, parent_execution_id: parentExecutionId,
				token: randomUUID(), owner_pid: process.pid, pid: null,
			};
			try {
				writeJsonAtomic(path.join(dir, "lease.json"), record);
				// Preserve ancestry after release so orphaned grandchildren remain discoverable.
				const parents = readParents(root).filter((entry) => entry.execution_id !== executionId);
				parents.push({ execution_id: executionId, parent_execution_id: parentExecutionId });
				writeJsonAtomic(path.join(root, "parents.json"), parents);
			} catch (error) {
				fs.rmSync(dir, { recursive: true, force: true });
				throw error;
			}
			let released = false;
			return {
				attach(pid) {
					if (!validPid(pid)) throw new Error("Agent PID must be a positive process id");
					withLeaseLock(paths, (root) => {
						const current = readLease(dir);
						if (released || current?.token !== record.token) throw new Error("Agent capacity lease is no longer owned by this execution");
						if (current.pid !== null && current.pid !== pid) throw new Error("Agent capacity lease already has an attached process");
						record.pid = pid;
						writeJsonAtomic(path.join(dir, "lease.json"), record);
						// Publish even after a concurrent close: the supervisor must be
						// able to find and terminate this already-spawned process.
						assertSubtreeOpen(root, executionId);
					});
				},
				release() {
					if (released) return;
					withLeaseLock(paths, () => {
						if (readLease(dir)?.token === record.token) fs.rmSync(dir, { recursive: true, force: true });
						released = true;
					});
				},
			};
		}
		throw new Error(`Agent concurrency capacity reached (${limit}, including root). Continue useful local work; delegate again after child feedback frees capacity.`);
	});
}

/** Select descendants from runtime-owned leases, not a host-wide process scan. */
export function descendantAgentPids(paths: RunPaths, executionId: string): number[] {
	if (!fs.existsSync(leaseRoot(paths))) return [];
	return withLeaseLock(paths, (root) => {
		const records = fs.readdirSync(root).filter((name) => /^\d+$/.test(name))
			.map((name) => readLease(path.join(root, name))).filter((record): record is LeaseRecord => record !== null);
		const parents = [...readParents(root), ...records];
		const descendants = new Set([executionId]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const record of parents) if (descendants.has(record.parent_execution_id) && !descendants.has(record.execution_id)) {
				descendants.add(record.execution_id); changed = true;
			}
		}
		return [...new Set(records.filter((record) => record.execution_id !== executionId && descendants.has(record.execution_id))
			.flatMap((record) => record.pid !== null && alive(record.pid) ? [record.pid] : []))];
	});
}
