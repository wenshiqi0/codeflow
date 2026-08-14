/**
 * `codeflow sub` — the outer loop's whole listening surface.
 *
 * One blocking call, never a poll: an execute loop that makes no progress must
 * cost the observer nothing. The caller passes the highest sequence it has
 * seen and gets back everything newer, so reconnecting never replays.
 *
 * Only file *names* are parsed. The name carries sequence, subject, kind, and
 * status, so the observer never opens an event body — which is what keeps the
 * metadata plane genuinely cheap and keeps run artifacts out of its context.
 *
 * A directory scan is the authority; the filesystem watch is only a hint about
 * when to scan. That ordering matters: `fs.watch` semantics differ across
 * platforms (inotify on Linux, FSEvents on macOS) and degrade on network
 * filesystems, but none of that can cause a missed event — at worst the wait
 * falls back to its polling interval.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_RUNS_DIR } from "./paths";

const EVENT_NAME =
	/^(?<seq>\d{5})--(?<subject>[a-z0-9-]+)--(?<kind>[a-z_]+)--(?<status>[A-Z_]+)\.json$/;

/** How often to rescan when no watch is available. */
const POLL_INTERVAL_MS = 250;

export interface ObservedEvent {
	seq: number;
	subject: string;
	kind: string;
	status: string;
	file: string;
}

export interface ScanResult {
	events: ObservedEvent[];
	waterMark: number;
}

/**
 * Read matching events from file names only.
 *
 * The watermark is the largest sequence *seen*, not the largest returned, so
 * filtered kinds still advance it and a later call is not forced to re-examine
 * them. It is also why gaps in the sequence are harmless.
 */
export function scan(directory: string, since: number, kinds: string[]): ScanResult {
	let waterMark = since;
	const events: ObservedEvent[] = [];

	let names: string[];
	try {
		names = fs
			.readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return { events, waterMark };
	}

	for (const name of names) {
		const match = EVENT_NAME.exec(name);
		if (!match?.groups) continue;
		const seq = Number.parseInt(match.groups.seq, 10);
		waterMark = Math.max(waterMark, seq);
		if (seq <= since) continue;
		if (kinds.length > 0 && !kinds.includes(match.groups.kind)) continue;
		events.push({
			seq,
			subject: match.groups.subject,
			kind: match.groups.kind,
			status: match.groups.status,
			file: name,
		});
	}

	events.sort((left, right) => left.seq - right.seq);
	return { events, waterMark };
}

/** Named-run streams live in events/; discovery watches the shared spool. */
export function watchDir(runsDir: string, runId?: string): string {
	return runId ? path.join(runsDir, runId, "events") : path.join(runsDir, "_spool");
}

/**
 * Suspend until the directory changes or the timeout expires.
 *
 * Resolves `true` when something may have happened, `false` on timeout. A
 * watch that cannot be established is not an error: the caller's contract is
 * "one call, suspended until something happens", not "inotify".
 */
function waitForChange(directory: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let watcher: fs.FSWatcher | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let poller: ReturnType<typeof setInterval> | null = null;

		const finish = (changed: boolean) => {
			if (settled) return;
			settled = true;
			watcher?.close();
			if (timer) clearTimeout(timer);
			if (poller) clearInterval(poller);
			resolve(changed);
		};

		try {
			// Observation is read-only, so a directory that does not exist yet
			// is never created here; the poll below covers that window.
			watcher = fs.watch(directory, () => finish(true));
			watcher.on("error", () => finish(true));
		} catch {
			watcher = null;
		}

		// Always keep a slow poll running: it covers a directory that appears
		// after this call started, and any platform where the watch is lossy.
		poller = setInterval(() => {
			if (fs.existsSync(directory)) finish(true);
		}, POLL_INTERVAL_MS);

		timer = setTimeout(() => finish(false), timeoutMs);
	});
}

export interface WaitOptions {
	runsDir: string;
	runId?: string;
	since: number;
	kinds: string[];
	timeoutSeconds: number;
}

export interface WaitResult {
	run_id: string | null;
	seq: number;
	events: ObservedEvent[];
}

export async function wait(options: WaitOptions): Promise<WaitResult> {
	const directory = watchDir(options.runsDir, options.runId);
	const deadline = Date.now() + options.timeoutSeconds * 1000;

	// Scan first: everything newer than the watermark may already be on disk,
	// and an observer that waited before looking would stall behind events it
	// had already been told about.
	let { events, waterMark } = scan(directory, options.since, options.kinds);

	while (events.length === 0) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await waitForChange(directory, Math.min(remaining, POLL_INTERVAL_MS * 4));
		({ events, waterMark } = scan(directory, options.since, options.kinds));
	}

	return { run_id: options.runId ?? null, seq: waterMark, events };
}

export async function main(argv: string[]): Promise<number> {
	let runId: string | undefined = process.env.CODEFLOW_RUN_ID;
	let runsDir = process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR;
	let since = 0;
	let timeout = 600;
	let kinds: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		const value = argv[index + 1];
		switch (token) {
			case "--run-id":
				runId = value;
				index++;
				break;
			case "--runs-dir":
				runsDir = value;
				index++;
				break;
			case "--since":
				since = Number.parseInt(value ?? "0", 10);
				index++;
				break;
			case "--timeout":
				timeout = Number.parseInt(value ?? "600", 10);
				index++;
				break;
			case "--kind":
				kinds = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
				index++;
				break;
			default:
				console.error(`codeflow sub: error: unknown option: ${token}`);
				return 1;
		}
	}

	if (!Number.isSafeInteger(since) || since < 0) {
		console.error("codeflow sub: error: --since must be a non-negative integer");
		return 1;
	}
	if (!Number.isSafeInteger(timeout) || timeout < 0) {
		console.error("codeflow sub: error: --timeout must be a non-negative integer");
		return 1;
	}

	const result = await wait({ runsDir, runId, since, kinds, timeoutSeconds: timeout });
	console.log(JSON.stringify(result, null, 2));
	return 0;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
