/**
 * Multi-source liveness probing.
 *
 * Outer coordinators repeatedly misdiagnose "the agent is dead" from a single
 * naive signal: an empty `ps aux | grep` (when ps is missing or filtered), a
 * quiet log (when output is buffered), or `stale: true` (which is an age, not
 * a verdict). Killing a working run is far more expensive than waiting for a
 * slow one, so this never concludes death from one signal.
 *
 * Signals, in order of trustworthiness:
 *
 * 1. `/proc/<pid>` exists            — Linux kernel process table
 * 2. `kill(pid, 0)` succeeds         — POSIX signal probe
 * 3. `/proc/<pid>/cmdline` names pi  — defends against PID reuse
 * 4. watchdog heartbeat freshness    — liveness/<pid>--<role>--<depth>.json
 *
 * Verdicts: ALIVE when 1+2+3 agree, DEAD when 1+2 both fail, otherwise
 * UNKNOWN. On macOS `/proc` does not exist, so honest answers there are often
 * UNKNOWN rather than a confident guess.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type Verdict = "ALIVE" | "DEAD" | "UNKNOWN";

export interface Signals {
	procPidExists: boolean | null;
	killSucceeded: boolean | null;
	cmdlineMatchesPi: boolean | null;
}

export interface Probe extends Signals {
	pid: number;
	verdict: Verdict;
	passedSignals: string[];
	heartbeatAgeSeconds: number | null;
	role?: string | null;
	depth?: number | null;
}

const PROC_ROOT = "/proc";

/** Whether the kernel accepts a null signal for this pid. */
export function killProbe(pid: number): boolean | null {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// EPERM means the process exists but belongs to another user.
		if (code === "EPERM") return true;
		if (code === "ESRCH") return false;
		return null;
	}
}

export function probeProcess(pid: number): Signals {
	const hasProc = fs.existsSync(PROC_ROOT);
	const procPidExists = hasProc ? fs.existsSync(path.join(PROC_ROOT, String(pid))) : null;
	const killSucceeded = killProbe(pid);

	let cmdlineMatchesPi: boolean | null = null;
	if (hasProc && procPidExists) {
		try {
			const raw = fs.readFileSync(path.join(PROC_ROOT, String(pid), "cmdline"), "utf-8");
			cmdlineMatchesPi = raw.includes("pi-coding-agent") || raw.split("\0")[0].includes("pi");
		} catch {
			cmdlineMatchesPi = null;
		}
	}

	return { procPidExists, killSucceeded, cmdlineMatchesPi };
}

export function verdictFor(signals: Signals): Verdict {
	if (signals.procPidExists && signals.killSucceeded && signals.cmdlineMatchesPi) {
		return "ALIVE";
	}
	if (signals.procPidExists === false && signals.killSucceeded === false) {
		return "DEAD";
	}
	return "UNKNOWN";
}

export function passedSignals(signals: Signals): string[] {
	const passed: string[] = [];
	if (signals.procPidExists) passed.push("proc");
	if (signals.killSucceeded) passed.push("kill0");
	if (signals.cmdlineMatchesPi) passed.push("cmdline");
	return passed;
}

export function heartbeatAge(record: Record<string, unknown>, now = Date.now()): number | null {
	const stamp = (record.heartbeat_at ?? record.started_at) as string | undefined;
	if (!stamp) return null;
	const parsed = Date.parse(stamp);
	if (Number.isNaN(parsed)) return null;
	return Math.max(0, Math.floor((now - parsed) / 1000));
}

export interface LivenessRecord {
	pid: number;
	role?: string | null;
	depth?: number | null;
	status?: string;
	heartbeat_at?: string;
	started_at?: string;
}

/** Read the watchdog's heartbeat records for a run. */
export function readLiveness(livenessDir: string): LivenessRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(livenessDir).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return [];
	}
	const records: LivenessRecord[] = [];
	for (const name of names) {
		try {
			const record = JSON.parse(
				fs.readFileSync(path.join(livenessDir, name), "utf-8"),
			) as LivenessRecord;
			if (typeof record.pid === "number") records.push(record);
		} catch {
			// A damaged heartbeat is one missing signal, not a failure.
		}
	}
	return records;
}

/** Probe every agent the watchdog knows about. */
export function probeAll(livenessDir: string, now = Date.now()): Probe[] {
	return readLiveness(livenessDir).map((record) => {
		// An exit already recorded is authoritative: no need to probe.
		if (record.status === "exited") {
			return {
				pid: record.pid,
				role: record.role ?? null,
				depth: record.depth ?? null,
				procPidExists: false,
				killSucceeded: false,
				cmdlineMatchesPi: null,
				verdict: "DEAD" as Verdict,
				passedSignals: [],
				heartbeatAgeSeconds: heartbeatAge(record, now),
			};
		}
		const signals = probeProcess(record.pid);
		return {
			pid: record.pid,
			role: record.role ?? null,
			depth: record.depth ?? null,
			...signals,
			verdict: verdictFor(signals),
			passedSignals: passedSignals(signals),
			heartbeatAgeSeconds: heartbeatAge(record, now),
		};
	});
}

/**
 * Exit code contract: 0 every agent alive, 1 at least one dead, 2 uncertain.
 *
 * UNKNOWN gets its own code so a caller can tell "it is gone" from "I cannot
 * tell" — collapsing those is exactly how a healthy run gets killed.
 */
export function exitCodeFor(probes: Probe[]): number {
	if (probes.some((probe) => probe.verdict === "DEAD")) return 1;
	if (probes.some((probe) => probe.verdict === "UNKNOWN")) return 2;
	return 0;
}
