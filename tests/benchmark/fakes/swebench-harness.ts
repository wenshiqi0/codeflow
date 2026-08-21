#!/usr/bin/env bun
/**
 * Test-support fake of the official SWE-bench harness evaluator
 * (tests/benchmark/fakes/README.md §2 — the seam contract).
 *
 * Spawned by the benchmark runner as:
 *   <this> --predictions <file> --run-id <evaluationRunId> --instance <id>
 *
 * - Prints the verdict token (resolved|unresolved|infra_error|not_evaluated)
 *   as the last stdout line, exit 0.
 * - FAKE_HARNESS_MODE=unavailable => exit 127 ("evaluator unavailable"): the
 *   runner must record not_evaluated + an explicit unexecuted-external-
 *   verification notice, never a fabricated verdict.
 * - Verdicts come from FAKE_HARNESS_VERDICTS (JSON map instance -> verdict);
 *   an absent instance is not_evaluated (the harness ran, nothing to grade).
 * - Validates the prediction it was handed really carries exactly the three
 *   official keys — otherwise exits 1 (mapped to infra_error by the runner).
 * - FAKE_HARNESS_NET_URL (fakes/README.md §6): when set, the harness makes a
 *   REAL HTTP request to that loopback URL (an "evaluator upstream" stand-in)
 *   and records {url, exit_code, ok} in its capture row — the tool-network
 *   tests use it to prove the evaluator invocation channel stays reachable
 *   under the same configuration that walls the agent tree.
 */

import * as fs from "node:fs";
import * as path from "node:path";

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1];
	return undefined;
}

const capture = process.env.FAKE_CAPTURE_DIR;
if (capture) fs.mkdirSync(capture, { recursive: true });

function appendCapture(row: Record<string, unknown>): void {
	if (!capture) return;
	fs.appendFileSync(path.join(capture, "harness-calls.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
}

if (process.env.FAKE_HARNESS_MODE === "unavailable") {
	appendCapture({ pid: process.pid, argv: process.argv.slice(2), mode: "unavailable", official_fields_ok: null });
	process.stderr.write("swebench-evaluator-unavailable: docker: command not found\n");
	process.exit(127);
}

const predictionsPath = argValue("--predictions");
const runId = argValue("--run-id");
const instanceId = argValue("--instance");

// The prediction handed to the official evaluator must satisfy the official
// field contract: exactly instance_id / model_name_or_path / model_patch.
let predictionKeys: string[] | null = null;
if (predictionsPath && fs.existsSync(predictionsPath)) {
	const lines = fs
		.readFileSync(predictionsPath, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0);
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.instance_id === instanceId) predictionKeys = Object.keys(parsed).sort();
		} catch {
			predictionKeys = ["<unparsable-line>"];
		}
	}
}
const officialFieldsOk =
	predictionKeys !== null && predictionKeys.join(",") === "instance_id,model_name_or_path,model_patch";

// The evaluator's own upstream connectivity check (optional; loopback only).
const harnessNetUrl = process.env.FAKE_HARNESS_NET_URL;
const netCheck: Record<string, unknown> | null = harnessNetUrl
	? (() => {
			const probed = Bun.spawnSync(["curl", "-fsS", "--max-time", "5", harnessNetUrl], {
				stdout: "pipe",
				stderr: "pipe",
			});
			return { url: harnessNetUrl, exit_code: probed.exitCode, ok: probed.exitCode === 0 };
		})()
	: null;

// Exactly ONE capture row per invocation (the acceptance tests count rows).
appendCapture({
	pid: process.pid,
	argv: process.argv.slice(2),
	run_id: runId ?? null,
	instance: instanceId ?? null,
	predictions_path: predictionsPath ?? null,
	prediction_keys: predictionKeys,
	official_fields_ok: officialFieldsOk,
	net_check: netCheck,
});

if (!officialFieldsOk) {
	process.stderr.write("fake-harness: prediction does not satisfy the official field contract\n");
	process.exit(1);
}

let verdict = "not_evaluated";
if (process.env.FAKE_HARNESS_VERDICTS) {
	try {
		const map = JSON.parse(process.env.FAKE_HARNESS_VERDICTS) as Record<string, string>;
		if (instanceId && map[instanceId]) verdict = map[instanceId];
	} catch {
		process.stderr.write("fake-harness: FAKE_HARNESS_VERDICTS is not valid JSON\n");
		process.exit(1);
	}
}

process.stdout.write(`${verdict}\n`);
process.exit(0);
