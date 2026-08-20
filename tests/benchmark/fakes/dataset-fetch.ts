#!/usr/bin/env bun
/**
 * Test-support fake of hub dataset resolution
 * (tests/benchmark/fakes/README.md §4 — the seam contract).
 *
 * Spawned by the benchmark runner as:
 *   <this> <hub-id>
 *
 * Prints one complete snapshot JSON document (contract §1.1) to stdout from
 * FAKE_FETCH_SNAPSHOT. FAKE_FETCH_MODE=alias prints the same snapshot with
 * revision "main" — a movable alias the loader must reject loudly instead of
 * recording as the resolved revision.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
const hubId = args.find((a) => !a.startsWith("--")) ?? args[0];

const capture = process.env.FAKE_CAPTURE_DIR;
if (capture) {
	fs.mkdirSync(capture, { recursive: true });
	fs.appendFileSync(
		path.join(capture, "fetch-calls.jsonl"),
		`${JSON.stringify({ pid: process.pid, argv: args, hub_id: hubId ?? null })}\n`,
		"utf8",
	);
}

if (!process.env.FAKE_FETCH_SNAPSHOT) {
	process.stderr.write("fake-fetch: FAKE_FETCH_SNAPSHOT is required\n");
	process.exit(1);
}

let document = JSON.parse(fs.readFileSync(process.env.FAKE_FETCH_SNAPSHOT, "utf8")) as Record<string, unknown>;
if (process.env.FAKE_FETCH_MODE === "alias") {
	document = { ...document, revision: "main" };
}
process.stdout.write(`${JSON.stringify(document)}\n`);
process.exit(0);
