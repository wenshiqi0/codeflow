#!/usr/bin/env bun

import {
	EvidenceError,
	runCommandEvidence,
	writeCommandReceipt,
} from "../lib/command-evidence";

function usage(): string {
	return (
		"usage: code-agent evidence run --id <id> -- <command> [args...]\n" +
		"       code-agent evidence receipt --output <file>"
	);
}

function flagValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
	try {
		const [command, ...rest] = argv;
		if (command === "run") {
			const separator = rest.indexOf("--");
			const options = separator >= 0 ? rest.slice(0, separator) : rest;
			const id = flagValue(options, "--id");
			if (!id || separator < 0 || options.length !== 2 || options[0] !== "--id") {
				throw new EvidenceError(usage());
			}
			return await runCommandEvidence(id, rest.slice(separator + 1));
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
