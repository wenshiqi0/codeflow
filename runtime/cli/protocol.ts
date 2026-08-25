#!/usr/bin/env bun

import * as fs from "node:fs";
import { CliError, RECEIPT_CHAIN_STATUSES, submitReceipt, type ReceiptChainStatus } from "../lib/handoff";
import { DEFAULT_RUNS_DIR, RunPaths } from "../lib/paths";
import { RECALL_LEVELS, recallGoal, recallHandoff, recallReceipt, type RecallLevel } from "../lib/recall";

interface Args {
	positional: string[];
	flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
	const positional: string[] = [];
	const flags = new Map<string, string[]>();
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const name = token.slice(2);
		const value = argv[++index];
		if (value === undefined) throw new CliError(`--${name} requires a value`);
		flags.set(name, [...(flags.get(name) ?? []), value]);
	}
	return { positional, flags };
}

function one(args: Args, name: string): string | undefined {
	return args.flags.get(name)?.[0];
}

function required(args: Args, name: string): string {
	const value = one(args, name);
	if (value === undefined) throw new CliError(`--${name} is required`);
	return value;
}

function paths(args: Args): RunPaths {
	const taskId = one(args, "task-id") ?? process.env.CODEFLOW_RUN_ID;
	if (!taskId) throw new CliError("--task-id or CODEFLOW_RUN_ID is required");
	return new RunPaths(
		one(args, "runs-dir") ?? process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR,
		taskId,
	);
}

async function jsonFile(args: Args): Promise<Record<string, unknown>> {
	const file = required(args, "file");
	const text = file === "-" ? await Bun.stdin.text() : fs.readFileSync(file, "utf8");
	const value = JSON.parse(text);
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new CliError("JSON input must be an object");
	}
	return value;
}

async function execute(args: Args): Promise<number> {
	const [group, command] = args.positional;
	if (group === "receipt" && command === "submit") {
		const value = await jsonFile(args);
		const status = value.status;
		if (typeof status !== "string" || !(RECEIPT_CHAIN_STATUSES as readonly string[]).includes(status)) {
			throw new CliError(`receipt status must be one of ${RECEIPT_CHAIN_STATUSES.join(", ")}`);
		}
		console.log(JSON.stringify(submitReceipt(paths(args), {
			handoffId: one(args, "handoff-id") ?? process.env.CODEFLOW_HANDOFF_ID ?? "",
			status: status as ReceiptChainStatus,
			effects: value.effects as never,
			established: value.established as never,
			decisions: value.decisions as never,
			discovered: value.discovered as never,
			unresolved: value.unresolved as never,
			blockers: value.blockers as never,
			resolved: value.resolved as never,
			resolvedUnresolved: value.resolvedUnresolved as never,
			resolvedBlockers: value.resolvedBlockers as never,
		}), null, 2));
		return 0;
	}
	if (group === "recall" && command === "goal") {
		const level = one(args, "level") ?? "state";
		if (!(RECALL_LEVELS as readonly string[]).includes(level)) {
			throw new CliError(`unknown recall level: ${level}`);
		}
		console.log(JSON.stringify(
			recallGoal(paths(args), required(args, "goal-id"), level as RecallLevel),
			null,
			2,
		));
		return 0;
	}
	if (group === "recall" && command === "handoff") {
		const level = one(args, "level") ?? "state";
		if (!(RECALL_LEVELS as readonly string[]).includes(level)) {
			throw new CliError(`unknown recall level: ${level}`);
		}
		console.log(JSON.stringify(
			recallHandoff(paths(args), required(args, "handoff-id"), level as RecallLevel),
			null,
			2,
		));
		return 0;
	}
	if (group === "recall" && command === "receipt") {
		const receiptId = required(args, "receipt-id");
		const receipt = recallReceipt(paths(args), receiptId, one(args, "handoff-id"));
		if (!receipt) throw new CliError(`unknown receipt: ${receiptId}`);
		console.log(JSON.stringify(receipt, null, 2));
		return 0;
	}
	throw new CliError("usage: receipt submit --file <json|-> | recall goal --goal-id <id> [--level state|semantic|full] | recall handoff --handoff-id <id> [--level state|semantic|full] | recall receipt --receipt-id <id> [--handoff-id <id>]");
}

export async function main(argv: string[]): Promise<number> {
	try {
		return await execute(parseArgs(argv));
	} catch (error) {
		if (error instanceof Error) {
			console.error(`code-agent: error: ${error.message}`);
			return 1;
		}
		throw error;
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
