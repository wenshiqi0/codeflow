#!/usr/bin/env bun
/**
 * `code-agent handoff` / `code-agent roster` / `code-agent facts`.
 *
 * The CLI surface is the whole mechanical plane: every state transition a role
 * can cause goes through a subcommand here, so no model ever writes state
 * directly. Output is JSON on stdout, diagnostics on stderr, and a non-zero
 * exit for a rejection.
 */

import * as fs from "node:fs";
import {
	agentsList,
	BLOCKED_REASONS,
	CliError,
	finishHandoff,
	handoffList,
	handoffStatus,
	openHandoff,
	runnerExited,
	runStart,
	startHandoff,
	TERMINAL_STATUSES,
	type TerminalStatus,
} from "../lib/handoff";
import { materialize, render } from "../lib/facts";
import { ledgerPath } from "../lib/facts";
import { goalViews } from "../lib/goals";
import { DEFAULT_RUNS_DIR, RunPaths } from "../lib/paths";

interface Args {
	positional: string[];
	flags: Map<string, string[]>;
	booleans: Set<string>;
}

const BOOLEAN_FLAGS = new Set(["active"]);

function parseArgs(argv: string[]): Args {
	const positional: string[] = [];
	const flags = new Map<string, string[]>();
	const booleans = new Set<string>();

	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const name = token.slice(2);
		if (BOOLEAN_FLAGS.has(name)) {
			booleans.add(name);
			continue;
		}
		const value = argv[++index];
		if (value === undefined) {
			throw new CliError(`--${name} requires a value`);
		}
		const existing = flags.get(name);
		if (existing) existing.push(value);
		else flags.set(name, [value]);
	}
	return { positional, flags, booleans };
}

function one(args: Args, name: string): string | undefined {
	return args.flags.get(name)?.[0];
}

function all(args: Args, name: string): string[] {
	return args.flags.get(name) ?? [];
}

function integer(args: Args, name: string): number | undefined {
	const raw = one(args, name);
	if (raw === undefined) return undefined;
	const value = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(value)) {
		throw new CliError(`--${name} must be an integer, got ${raw}`);
	}
	return value;
}

function resolveRunId(args: Args): string {
	const runId = one(args, "run-id") ?? process.env.CODEFLOW_RUN_ID;
	if (!runId) {
		throw new CliError(
			"--run-id is required (or set CODEFLOW_RUN_ID; `codeflow exec` allocates and exports it)",
		);
	}
	return runId;
}

function resolveHandoffId(args: Args): string {
	const id = one(args, "id") ?? process.env.CODEFLOW_HANDOFF_ID;
	if (!id) throw new CliError("--id is required (or set CODEFLOW_HANDOFF_ID)");
	return id;
}

function resolvePaths(args: Args): RunPaths {
	const runsDir = one(args, "runs-dir") ?? process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR;
	return new RunPaths(runsDir, resolveRunId(args));
}

function emit(value: unknown, pretty = false): void {
	console.log(pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
}

async function readBody(args: Args): Promise<string> {
	const bodyFile = one(args, "body-file");
	if (bodyFile === "-") {
		return await Bun.stdin.text();
	}
	if (bodyFile) {
		if (!fs.existsSync(bodyFile)) {
			throw new CliError(`handoff body not found: ${bodyFile}`);
		}
		return fs.readFileSync(bodyFile, "utf-8");
	}
	return "";
}

function requireFlag(args: Args, name: string): string {
	const value = one(args, name);
	if (value === undefined) throw new CliError(`--${name} is required`);
	return value;
}

/**
 * A root PASS is a claim that every immutable goal contract is satisfied.
 * The derived join, rather than the planner's prose receipt, owns that fact.
 */
export function assertRootPassGoalJoins(paths: RunPaths, handoffId: string): void {
	const state = handoffStatus(paths, handoffId);
	if (Array.isArray(state)) throw new CliError(`handoff not found: ${handoffId}`);
	if ((state.depth ?? 0) !== 0 || state.lineage.parent_handoff_id) return;

	const unsatisfied = goalViews(paths).flatMap((view) =>
		view.join.satisfied
			? []
			: view.join.unsatisfied.map((entry) => `${view.goal_id}: ${entry}`),
	);
	if (unsatisfied.length > 0) {
		throw new CliError(
			`root PASS requires every goal join to be satisfied: ${unsatisfied.join("; ")}`,
		);
	}
}

async function runHandoff(command: string, args: Args): Promise<number> {
	const paths = resolvePaths(args);

	switch (command) {
		case "open": {
			const result = openHandoff(paths, {
				role: requireFlag(args, "role"),
				body: await readBody(args),
				depth: integer(args, "depth"),
				parentId: one(args, "parent-id") ?? null,
				parentRunId: one(args, "parent-run-id") ?? null,
				splitScope: one(args, "split-scope") ?? null,
				title: one(args, "title") ?? null,
				scope: all(args, "scope"),
			});
			if (result.warning) {
				console.error(`warning: ${result.warning}`);
			}
			const { warning, ...payload } = result;
			emit(payload);
			return 0;
		}

		case "start": {
			emit(startHandoff(paths, resolveHandoffId(args), integer(args, "pid")));
			return 0;
		}

		case "finish": {
			const status = requireFlag(args, "status");
			if (!(TERMINAL_STATUSES as readonly string[]).includes(status)) {
				throw new CliError(
					`--status must be one of ${TERMINAL_STATUSES.join(", ")}, got ${status}`,
				);
			}
			const handoffId = resolveHandoffId(args);
			if (status === "PASS") assertRootPassGoalJoins(paths, handoffId);
			emit(
				finishHandoff(paths, {
					handoffId,
					status: status as TerminalStatus,
					summary: requireFlag(args, "summary"),
					receipt: one(args, "receipt") ?? null,
					artifacts: all(args, "artifact"),
					blockedReasons: all(args, "blocked-reason"),
					detail: one(args, "detail") ?? null,
					budget: {
						limit: integer(args, "budget-limit"),
						used: integer(args, "budget-used"),
						remaining: integer(args, "budget-remaining"),
						protectedComponent: one(args, "protected-component"),
						requiredAction: one(args, "required-action"),
						largestSources: JSON.parse(one(args, "largest-sources") ?? "[]"),
						sourceRefs: JSON.parse(one(args, "source-refs") ?? "[]"),
					},
				}),
			);
			return 0;
		}

		case "status": {
			const id = one(args, "id") ?? process.env.CODEFLOW_HANDOFF_ID;
			emit(handoffStatus(paths, id), true);
			return 0;
		}

		case "list": {
			emit(handoffList(paths, args.booleans.has("active")), true);
			return 0;
		}

		case "run-start": {
			const pid = integer(args, "pid");
			if (pid === undefined) throw new CliError("--pid is required");
			emit(runStart(paths, requireFlag(args, "role"), pid));
			return 0;
		}

		case "runner-exited": {
			const pid = integer(args, "pid");
			const depth = integer(args, "depth");
			if (pid === undefined) throw new CliError("--pid is required");
			if (depth === undefined) throw new CliError("--depth is required");
			emit(runnerExited(paths, pid, requireFlag(args, "role"), depth));
			return 0;
		}

		default:
			throw new CliError(
				`unknown handoff subcommand: ${command}; expected open, start, finish, ` +
					"status, list, run-start, or runner-exited",
			);
	}
}

function runFacts(command: string, args: Args): number {
	const paths = resolvePaths(args);
	const ledger = ledgerPath(paths.runDir);

	switch (command) {
		case "render": {
			const rendered = render(ledger);
			if (rendered) console.log(rendered);
			return 0;
		}
		case "list":
			emit(materialize(ledger), true);
			return 0;
		default:
			throw new CliError(`unknown facts subcommand: ${command}; expected render or list`);
	}
}

export async function main(argv: string[]): Promise<number> {
	try {
		const args = parseArgs(argv);
		const [group, command] = args.positional;

		if (!group) {
			throw new CliError("usage: <handoff|agents|facts> <subcommand> [options]");
		}

		switch (group) {
			case "handoff":
				if (!command) throw new CliError("handoff requires a subcommand");
				return await runHandoff(command, args);

			case "agents": {
				if (command !== "list") {
					throw new CliError(`unknown agents subcommand: ${command ?? "(none)"}; expected list`);
				}
				const rows = agentsList(resolvePaths(args));
				if ((one(args, "format") ?? "lines") === "json") {
					emit(rows, true);
				} else {
					for (const row of rows) console.log(JSON.stringify(row));
				}
				return 0;
			}

			case "facts":
				if (!command) throw new CliError("facts requires a subcommand");
				return runFacts(command, args);

			default:
				throw new CliError(`unknown group: ${group}; expected handoff, agents, or facts`);
		}
	} catch (error) {
		if (error instanceof CliError) {
			console.error(`code-agent: error: ${error.message}`);
			return 1;
		}
		throw error;
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
