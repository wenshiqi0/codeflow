#!/usr/bin/env bun
/** Historical Codemark artifact reader. Live inner-Agent organization is retired. */

import * as path from "node:path";
import { readPublishedOrganization } from "../lib/organization";

export const VERSION = "0.1.0";
export const RETIRED_MESSAGE = "Codemark live runs are retired: Pi executors no longer organize or delegate. Use codeteam for outer orchestration; codemark report --run <dir> reads historical artifacts. No model was started.";

export function usage(): string {
	return "usage: codemark report --run <dir>\n\nRead a historical initial-organization.json artifact without a model call.\nLive initial-organization measurements are retired; use codeteam for outer orchestration.\n\n  --help\n  --version";
}

export function main(argv: string[]): number {
	if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
		console.log(usage());
		return 0;
	}
	if (argv.length === 1 && argv[0] === "--version") {
		console.log(`codemark ${VERSION}`);
		return 0;
	}
	if (argv[0] !== "report") {
		console.error(`codemark: error: ${RETIRED_MESSAGE}`);
		return 2;
	}
	if (argv.length === 2 && ["--help", "-h"].includes(argv[1])) {
		console.log(usage());
		return 0;
	}
	if (argv.length !== 3 || argv[1] !== "--run" || !argv[2] || argv[2].startsWith("--")) {
		console.error("codemark: error: report requires exactly --run <dir>");
		return 2;
	}
	try {
		const artifact = readPublishedOrganization(path.resolve(argv[2]));
		console.log(JSON.stringify({
			measurement: "historical-inner-agent-initial-organization",
			outer_orchestration_measurement: false,
			artifact,
		}, null, 2));
		return 0;
	} catch (error) {
		console.error(`codemark: error: ${(error as Error).message}`);
		return 1;
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
