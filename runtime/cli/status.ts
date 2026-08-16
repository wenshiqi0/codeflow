#!/usr/bin/env bun
/**
 * Liveness rendering: is the execute loop alive?
 *
 * No binary dispatches this diagnostic entry point on the outer PATH. The old
 * `probe` and `agent-status` verbs are gone because an ungated liveness query
 * invites an observer to poll it every turn; `codeflow audit` uses the same
 * bounded probe only after its health gate admits the run.
 *
 * The exit code is the contract, and it keeps three cases apart on purpose:
 *
 *   0 — every known agent is alive
 *   1 — at least one is dead
 *   2 — cannot tell
 *
 * Collapsing 2 into 1 is how a healthy run gets killed, which costs far more
 * than waiting for a slow one.
 */

import { exitCodeFor, probeAll, type Probe } from "../lib/liveness";
import { DEFAULT_RUNS_DIR, RunPaths } from "../lib/paths";

function parse(argv: string[]): { runId?: string; runsDir: string; json: boolean } {
	let runId = process.env.CODEFLOW_RUN_ID;
	let runsDir = process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR;
	let json = false;

	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (token === "--run-id") runId = argv[++index];
		else if (token === "--runs-dir") runsDir = argv[++index];
		else if (token === "--format") json = argv[++index] === "json";
		else if (token === "--json") json = true;
	}
	return { runId, runsDir, json };
}

function describe(probe: Probe): string {
	const signals = probe.passedSignals.length > 0 ? probe.passedSignals.join("+") : "none";
	const age = probe.heartbeatAgeSeconds === null ? "?" : `${probe.heartbeatAgeSeconds}s`;
	return `${probe.verdict} pid=${probe.pid} role=${probe.role ?? "?"} depth=${
		probe.depth ?? "?"
	} signals=${signals} heartbeat=${age}`;
}

export function main(argv: string[]): number {
	const { runId, runsDir, json } = parse(argv);
	if (!runId) {
		console.error(
			"liveness: error: --run-id is required (or set CODEFLOW_RUN_ID)",
		);
		return 2;
	}

	const paths = new RunPaths(runsDir, runId);
	const probes = probeAll(paths.liveness);

	if (json) {
		console.log(JSON.stringify({ run_id: runId, agents: probes }, null, 2));
	} else if (probes.length === 0) {
		// No heartbeats is not death: the watchdog may not have written one yet.
		console.log(`UNKNOWN run=${runId} no liveness records`);
	} else {
		for (const probe of probes) console.log(describe(probe));
	}

	return probes.length === 0 ? 2 : exitCodeFor(probes);
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
