#!/usr/bin/env bun

import {
	EvidenceError,
	runCommandEvidence,
	writeCommandReceipt,
} from "../lib/command-evidence";

function usage(): string {
	return (
		"usage: code-agent evidence run --id <id> [--timeout-ms <ms>] -- <command> [args...]\n" +
		"       code-agent evidence receipt --output <file>\n" +
		"\n" +
		"--timeout-ms overrides CODEFLOW_EVIDENCE_TIMEOUT_MS; 0 disables the guard.\n" +
		"A timed-out command is killed with its whole process tree and recorded\n" +
		"as exit 124, failure_class RUNNER_BLOCKED, error_class EXECUTION_TIMEOUT."
	);
}

function flagValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : undefined;
}

const RUN_FLAGS = new Set(["--id", "--timeout-ms"]);

/** Parse strict flag/value pairs before the `--` separator. */
function parseRunFlags(options: string[]): { id?: string; timeoutMs?: string } {
	const parsed: { id?: string; timeoutMs?: string } = {};
	for (let index = 0; index < options.length; index += 2) {
		const flag = options[index];
		if (!RUN_FLAGS.has(flag) || index + 1 >= options.length) throw new EvidenceError(usage());
		if (flag === "--id") parsed.id = options[index + 1];
		else parsed.timeoutMs = options[index + 1];
	}
	return parsed;
}

export async function main(argv: string[]): Promise<number> {
	try {
		const [command, ...rest] = argv;
		if (command === "run") {
			const separator = rest.indexOf("--");
			const options = separator >= 0 ? rest.slice(0, separator) : rest;
			const { id, timeoutMs } = parseRunFlags(options);
			if (!id || separator < 0) {
				throw new EvidenceError(usage());
			}
			return await runCommandEvidence(id, rest.slice(separator + 1), { timeoutMs });
		}
		if (command === "receipt") {
			const output = flagValue(rest, "--output");
			if (!output || rest.length !== 2 || rest[0] !== "--output") {
				throw new EvidenceError(usage());
			}
			console.log(JSON.stringify(writeCommandReceipt(output)));
			return 0;
		}
		throw new EvidenceError(usage());
	} catch (error) {
		if (error instanceof EvidenceError) {
			console.error(`code-agent evidence: error: ${error.message}`);
			return 1;
		}
		throw error;
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
