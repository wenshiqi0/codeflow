/**
 * Liveness ignition for one codeflow agent process.
 *
 * Four responsibilities, then stay quiet:
 *
 * 1. Mark this process's handoff `running`. The receiver owns that
 *    transition, and hanging it on a lifecycle hook means no model has to
 *    remember it.
 * 2. Spawn a detached watchdog for this pid. A plugin dies inside the
 *    process it would report on, so the exit receipt has to come from
 *    outside; `detached` + ignored stdio + `unref()` is what lets the
 *    monitor outlive its subject without holding this event loop open.
 * 3. Stream-idle abort (see STREAM_IDLE_TIMEOUT_MS below): a provider can
 *    stall mid-stream while keeping the connection byte-busy with heartbeat
 *    comments, which defeats every byte/transport-level timeout. This layer
 *    aborts the in-flight request when no real `message_update`/tool event
 *    arrives for the configured window, so the run fails fast instead of
 *    hanging forever.
 * 4. Bound bash tool wall time. Provider-idle protection cannot see a shell
 *    process that never returns, so bash gets its own configurable hard limit.
 *
 * No tools are registered: this extension has no model-facing surface. With
 * no run-id in the environment there is no run to record, so (1) and (2)
 * are skipped — running `pi` by hand stays possible. (3) still applies.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startHandoff } from "../../lib/handoff";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import { BASH_TIMEOUT_ABORT_MARKER, STREAM_IDLE_ABORT_MARKER } from "../codeflow-task/handoff-gate";

// Re-exported so producers and consumers (and the contract tests) can read
// the marker from either side of the boundary.
export { BASH_TIMEOUT_ABORT_MARKER };

// .codeflow/extensions/agent-watchdog/index.ts -> .codeflow
const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WATCHDOG_SCRIPT = path.join(RUNTIME_DIR, "lib", "watchdog.ts");
const HEARTBEAT_SECONDS = "60";

/**
 * Stream-idle abort (the third responsibility).
 *
 * A provider can stall mid-stream and keep the TCP connection alive with
 * trickle bytes (SSE heartbeat comments). That defeats every byte-level
 * timeout: undici `bodyTimeout` resets on any data (verified), and TCP
 * keepalive probes get ACKed by the healthy peer stack (verified). The only
 * signal that survives is "no real content/thinking token for N seconds
 * while a provider request is in flight", because SSE comments do not fire
 * `message_update`. This layer owns that signal and aborts the stalled
 * request via `ctx.abort()`, which trips the AbortSignal pi passes into the
 * provider fetch — turning an infinite hang into a recoverable turn failure.
 *
 * The default is derived from two existing bounds, not guessed:
 * DEFAULT_STALE_SECONDS = 600 in runtime/lib/handoff/index.ts is the age at which
 * the state layer first calls a silent handoff "stale" (its own docs treat
 * ten minutes of quiet reasoning as normal), plus the previous 300s of
 * abort patience on top. An idle abort firing before the age annotation
 * would kill requests the rest of the runtime still considers ordinary
 * work; a genuinely dead stream is still bounded at ~15 min instead of
 * never.
 */
export const STREAM_IDLE_DEFAULT_MS = 900_000;
export const STREAM_IDLE_TIMEOUT_MS = Number.parseInt(
	process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS ?? String(STREAM_IDLE_DEFAULT_MS),
	10,
);
const STREAM_IDLE_TICK_MS = Number.parseInt(
	process.env.CODEFLOW_STREAM_IDLE_TICK_MS ?? "15000",
	10,
);

/**
 * A bash command may legitimately compile or test for several minutes, but a
 * forgotten root walk must not own a run indefinitely. Fifteen minutes matches
 * the provider-idle ceiling and remains overrideable; 0 disables the guard.
 * Verification commands have their own tighter recorder-level timeout (see
 * runtime/lib/command-evidence.ts) that fires first and returns control to
 * the role; this ceiling is the turn-wide backstop behind it.
 */
export const BASH_TIMEOUT_DEFAULT_MS = 900_000;
export const BASH_TIMEOUT_MS = Number.parseInt(
	process.env.CODEFLOW_BASH_TIMEOUT_MS ?? String(BASH_TIMEOUT_DEFAULT_MS),
	10,
);
// The abort line's prefix is BASH_TIMEOUT_ABORT_MARKER, imported from
// codeflow-task/handoff-gate: the watchdog produces it and the delegation
// gate consumes it, so both sides share the one string.

let currentCtx: ExtensionContext | null = null;
let lastProgressAt = Date.now();
/**
 * True while a provider turn is in flight (request sent, response not
 * finished). Brackets the whole turn — including the time-to-first-token wait
 * before any `message_update` — so TTFT stalls are covered. We deliberately
 * do NOT gate on pi's reported idle flag: pi may report the agent as idle
 * during TTFT, which is exactly when a dead connection stalls, and gating on
 * it silently skips that case (verified: a TTFT stall ran 10+ minutes without
 * firing).
 */
let providerInFlight = false;
const bashTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Stamp progress and remember the latest context for the idle timer. */
function markProgress(ctx: ExtensionContext | null | undefined): void {
	lastProgressAt = Date.now();
	if (ctx) currentCtx = ctx;
}

function clearBashTimer(toolCallId: string): void {
	const timer = bashTimers.get(toolCallId);
	if (timer) clearTimeout(timer);
	bashTimers.delete(toolCallId);
}

function clearAllBashTimers(): void {
	for (const timer of bashTimers.values()) clearTimeout(timer);
	bashTimers.clear();
}

let ignited = false;

function markHandoffRunning(runId: string, handoffId: string): void {
	try {
		startHandoff(
			new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, runId),
			handoffId,
			process.pid,
		);
	} catch {
		// Already terminal, or no such handoff: neither is this layer's business.
	}
}

function igniteWatchdog(runId: string, role: string, depth: string): void {
	if (!fs.existsSync(WATCHDOG_SCRIPT)) return;
	const child = spawn(
		"bun",
		[
			WATCHDOG_SCRIPT,
			"--pid",
			String(process.pid),
			"--role",
			role,
			"--depth",
			depth,
			"--run-id",
			runId,
			"--interval",
			HEARTBEAT_SECONDS,
		],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", () => {
		if (ignited) return;
		ignited = true;

		const runId = process.env.CODEFLOW_RUN_ID;
		if (!runId) return;
		const role = process.env.CODEFLOW_AGENT_ROLE ?? "unknown";
		const depth = process.env.CODEFLOW_AGENT_DEPTH ?? "0";
		const handoffId = process.env.CODEFLOW_HANDOFF_ID;

		if (handoffId) markHandoffRunning(runId, handoffId);
		igniteWatchdog(runId, role, depth);
	});

	// --- Stream-idle abort (responsibility 3) -------------------------------
	// Stamp progress on every real streaming/tool event. SSE heartbeat
	// comments do not fire these, so the idle clock keeps running while a
	// stalled provider trickles keepalive bytes. `providerInFlight` brackets
	// the whole turn (request -> turn_end), covering TTFT stalls too.
	pi.on("turn_start", (_e, ctx) => {
		providerInFlight = true;
		markProgress(ctx);
	});
	pi.on("before_provider_request", (_e, ctx) => {
		providerInFlight = true;
		markProgress(ctx);
	});
	pi.on("after_provider_response", (_e, ctx) => markProgress(ctx));
	pi.on("message_start", (_e, ctx) => markProgress(ctx));
	pi.on("message_update", (_e, ctx) => markProgress(ctx));
	pi.on("tool_execution_start", (event, ctx) => {
		markProgress(ctx);
		if (
			event.toolName !== "bash" ||
			!Number.isFinite(BASH_TIMEOUT_MS) ||
			BASH_TIMEOUT_MS <= 0
		) {
			return;
		}
		clearBashTimer(event.toolCallId);
		const timer = setTimeout(() => {
			bashTimers.delete(event.toolCallId);
			process.stderr.write(
				`${BASH_TIMEOUT_ABORT_MARKER} ${event.toolCallId} exceeded ${BASH_TIMEOUT_MS}ms ` +
					`(set CODEFLOW_BASH_TIMEOUT_MS=0 to disable); aborting tool execution\n`,
			);
			try {
				ctx.abort();
			} catch {
				// The command is already terminal or the host is shutting down.
			}
		}, BASH_TIMEOUT_MS);
		timer.unref();
		bashTimers.set(event.toolCallId, timer);
	});
	pi.on("tool_execution_update", (_e, ctx) => markProgress(ctx));
	pi.on("tool_execution_end", (event, ctx) => {
		markProgress(ctx);
		clearBashTimer(event.toolCallId);
	});
	// Turn / agent boundaries: the request is no longer in flight.
	const clearInFlight = (): void => {
		providerInFlight = false;
	};
	pi.on("message_end", clearInFlight);
	pi.on("turn_end", clearInFlight);
	pi.on("agent_end", () => {
		clearInFlight();
		clearAllBashTimers();
	});
	pi.on("agent_settled", () => {
		clearInFlight();
		clearAllBashTimers();
	});

	if (
		Number.isFinite(STREAM_IDLE_TIMEOUT_MS) &&
		STREAM_IDLE_TIMEOUT_MS > 0 &&
		Number.isFinite(STREAM_IDLE_TICK_MS) &&
		STREAM_IDLE_TICK_MS > 0
	) {
		setInterval(() => {
			if (!providerInFlight) return;
			const ctx = currentCtx;
			if (!ctx) return;
			const idleMs = Date.now() - lastProgressAt;
			if (idleMs <= STREAM_IDLE_TIMEOUT_MS) return;
			process.stderr.write(
				`${STREAM_IDLE_ABORT_MARKER} ${idleMs}ms > ${STREAM_IDLE_TIMEOUT_MS}ms ` +
					`(set CODEFLOW_STREAM_IDLE_TIMEOUT_MS=0 to disable); aborting stalled provider request\n`,
			);
			lastProgressAt = Date.now(); // give the abort room before re-entry
			try {
				ctx.abort();
			} catch {
				// abort() throwing is still better than hanging; ignore.
			}
		}, STREAM_IDLE_TICK_MS).unref();
	}
}
