#!/usr/bin/env bun
/**
 * `codeflow exec` and `code-agent delegate` — resolve a role and supervise its
 * pi process.
 *
 * One implementation, two entry points, because the two rings mean different
 * things by it. `exec` starts a run from a requirement: it allocates the run id
 * and announces it. `delegate` runs a role inside a run that already exists and
 * inherits that id from the environment. Splitting the spelling keeps "run" out
 * of a role's vocabulary entirely, so no role can mistake delegating a unit of
 * work for starting a whole run.
 *
 * pi is spawned and waited on rather than exec'd. Replacing this process would
 * leave nobody to reap pi or anything it detaches, which produces zombies
 * under a non-init PID 1 — the normal case in a container.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { finishHandoff, openHandoff, runStart, runnerChildStarted, runnerExited } from "./handoff";
import { DEFAULT_RUNS_DIR, RunPaths } from "./paths";
import { buildArgv, listRoles, readFrontmatter, resolveRole, RoleError } from "./roles";

const RUNTIME_DIR = path.resolve(import.meta.dir, "..");
const AGENTS_DIR = path.join(RUNTIME_DIR, "agents");
const VERSION = "0.1.0";
const EXTENSIONS = [
	path.join(RUNTIME_DIR, "extensions", "codeflow-task", "index.ts"),
	path.join(RUNTIME_DIR, "extensions", "codeflow-context", "index.ts"),
	path.join(RUNTIME_DIR, "extensions", "agent-watchdog", "index.ts"),
];

/**
 * Sortable, lowercase, filesystem- and event-filename-safe.
 *
 * Sortable matters: run directories listed alphabetically come out in
 * chronological order, so finding the latest run needs no metadata.
 */
export function newRunId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	return `run-${stamp}-${randomBytes(2).toString("hex")}`;
}

function fail(message: string, command = "exec"): number {
	console.error(`codeflow ${command}: error: ${message}`);
	return 1;
}

interface ParsedRun {
	role?: string;
	prompt: string;
	printOnly: boolean;
	handoffFile?: string;
}

function parseDelegate(argv: string[]): ParsedRun {
	let role: string | undefined;
	let handoffFile: string | undefined;
	let printOnly = false;
	const prompt: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		// `--role` is the spelling the inner vocabulary uses; `--agent` stays
		// accepted so a role prompt or script from before the split still works.
		if (token === "--role" || token === "--agent") {
			role = argv[++index];
		} else if (token === "--handoff-file") {
			handoffFile = argv[++index];
		} else if (token === "--print") {
			printOnly = true;
		} else {
			prompt.push(token);
		}
	}
	return { role, prompt: prompt.join(" "), printOnly, handoffFile };
}

function parseExec(argv: string[]): ParsedRun | { error: string } {
	const prompt: string[] = [];
	for (const token of argv) {
		if (token === "--role" || token === "--agent") {
			return { error: `${token} is a delegate-only role option; exec always starts the planner` };
		}
		if (token === "--handoff-file") {
			return { error: `${token} is delegate-only; handoff state belongs to code-agent delegate` };
		}
		if (token === "--print") {
			return { error: "--print is delegate-only; exec starts the planner and follows the run" };
		}
		if (token.startsWith("--")) return { error: `unknown exec option: ${token}` };
		prompt.push(token);
	}
	return { role: "planner", prompt: prompt.join(" "), printOnly: false, handoffFile: undefined };
}

/**
 * `entry` only changes how arguments are validated and reported.
 *
 * `exec` takes a requirement and always drives the planner: choosing the role
 * is the planner's job, not the caller's. `delegate` takes an explicit role
 * because that is precisely the decision the planner is making.
 */
export async function run(argv: string[], entry: "exec" | "delegate" = "delegate"): Promise<number> {
	const parsed = entry === "exec" ? parseExec(argv) : parseDelegate(argv);
	if ("error" in parsed) return fail(parsed.error, entry);
	const args = parsed;

	if (entry === "exec") {
		if (args.prompt.trim() === "") {
			return fail("exec requires a requirement", "exec");
		}
		args.role ??= "planner";
	}
	if (!args.role) return fail("delegate requires --role ROLE", "delegate");

	let resolved;
	try {
		resolved = resolveRole(AGENTS_DIR, args.role);
	} catch (error) {
		if (error instanceof RoleError) return fail(error.message, entry);
		throw error;
	}
	if (resolved === null) return fail(`unknown role: ${args.role}`, entry);

	const inherited = process.env.CODEFLOW_RUN_ID;
	const freshRun = inherited === undefined;
	const runId = inherited ?? newRunId();
	const runsDir = process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR;
	let handoffId = process.env.CODEFLOW_HANDOFF_ID;

	// --print resolves the binding and exits. It must not register a run, emit
	// events, or create directories: a diagnostic that leaves artifacts behind
	// teaches people to ignore artifacts.
	if (args.printOnly) {
		console.log(
			JSON.stringify({
				role: args.role,
				env: {
					CODEFLOW_AGENT_ROLE: args.role,
					CODEFLOW_AGENT_DEPTH: freshRun ? "0" : "1",
					CODEFLOW_RUN_ID: runId,
					...(handoffId ? { CODEFLOW_HANDOFF_ID: handoffId } : {}),
					PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? RUNTIME_DIR,
				},
				argv: buildArgv(resolved, args.prompt, EXTENSIONS),
			}),
		);
		return 0;
	}

	const paths = new RunPaths(runsDir, runId);

	if (args.handoffFile) {
		if (!fs.existsSync(args.handoffFile)) {
			return fail(`handoff body not found: ${args.handoffFile}`, entry);
		}
		const opened = openHandoff(paths, {
			role: args.role,
			depth: 0,
			body: fs.readFileSync(args.handoffFile, "utf-8"),
		});
		handoffId = opened.handoff_id;
	}

	// The requirement is recorded with the run so `ls` can label it without
	// reading anything from inside the execute loop.
	if (freshRun) {
		runStart(paths, args.role, process.pid, args.prompt);
	}

	console.error(
		`codeflow run_id=${runId} run_dir=${paths.runDir} handoff_id=${handoffId ?? "-"}`,
	);

	let child: Bun.Subprocess | undefined;
	let escalation: ReturnType<typeof setTimeout> | undefined;
	const terminateChild = (signal: "SIGTERM" | "SIGKILL"): void => {
		if (child?.pid === undefined) return;
		try {
			process.kill(-child.pid, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				// The child is already gone.
			}
		}
	};
	const onTermination = (): void => {
		terminateChild("SIGTERM");
		if (escalation) clearTimeout(escalation);
		escalation = setTimeout(() => terminateChild("SIGKILL"), 5_000);
	};
	if (freshRun) {
		process.on("SIGTERM", onTermination);
		process.on("SIGINT", onTermination);
	}

	child = Bun.spawn(buildArgv(resolved, args.prompt, EXTENSIONS), {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		detached: freshRun,
		env: {
			...process.env,
			PATH: `${path.join(RUNTIME_DIR, "bin")}:${process.env.PATH ?? ""}`,
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? RUNTIME_DIR,
			CODEFLOW_AGENT_ROLE: args.role,
			CODEFLOW_AGENT_DEPTH: freshRun ? "0" : "1",
			CODEFLOW_RUN_ID: runId,
			...(handoffId ? { CODEFLOW_HANDOFF_ID: handoffId } : {}),
		},
	});
	if (freshRun && child.pid !== undefined) runnerChildStarted(paths, child.pid);

	const code = await child.exited;
	if (escalation) clearTimeout(escalation);

	// The watchdog may have missed the exit; recording it here is what lets an
	// outer loop distinguish "finished" from "died without finishing".
	try {
		runnerExited(paths, child.pid, args.role, freshRun ? 0 : 1);
	} catch {
		// Never let bookkeeping mask the child's exit code.
	}

	return code;
}

function debug(argv: string[]): number {
	const [sub, name] = argv;
	if (sub === "agent") {
		if (!name) {
			for (const role of listRoles(AGENTS_DIR)) console.log(role);
			return 0;
		}
		const frontmatter = readFrontmatter(AGENTS_DIR, name);
		if (frontmatter === null) return fail(`unknown agent: ${name}`);
		console.log(`agent: ${name}`);
		console.log(`description: ${frontmatter.description ?? ""}`);
		console.log(`model: ${frontmatter.model ?? ""}`);
		if (frontmatter.tools) console.log(`tools: ${frontmatter.tools}`);
		if (frontmatter.delegates) console.log(`delegates: ${frontmatter.delegates}`);
		return 0;
	}
	if (sub === "skill") {
		const skills = path.join(RUNTIME_DIR, "skills");
		try {
			for (const entry of fs.readdirSync(skills, { withFileTypes: true }).sort()) {
				if (entry.isDirectory()) console.log(entry.name);
			}
		} catch {
			return fail(`skills directory not found: ${skills}`);
		}
		return 0;
	}
	return fail("debug requires a subcommand: agent | skill");
}

export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	switch (command) {
		case "exec":
			return await run(rest, "exec");
		case "delegate":
			return await run(rest, "delegate");
		case "debug":
			return debug(rest);
		case "--version":
			console.log(VERSION);
			return 0;
		default:
			return fail("usage: <exec|delegate|debug> ...");
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
