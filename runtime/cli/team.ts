#!/usr/bin/env bun
/** JSON control plane for the outer loop; never a second model manager. */
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { RunPaths, DEFAULT_RUNS_DIR } from "../lib/paths";
import { assertTeamId, assignmentView, createTeam, createTeamGoal, finishTeam, launchTeamAgent, stopTeamAgents, teamStatus } from "../lib/team";
import { inspectCommitment, inspectGoal, inspectReceipt } from "../lib/inspection";
import { loadTask } from "../lib/tasks";
import { watchTeam } from "../lib/team-watch";

interface Args { positional: string[]; options: Record<string, string> }
function parse(values: string[], allowed: string[]): Args {
	const positional: string[] = []; const options: Record<string, string> = {};
	for (let i = 0; i < values.length; i++) {
		const item = values[i];
		if (!item.startsWith("--")) { positional.push(item); continue; }
		const key = item.slice(2);
		if (!allowed.includes(key) || key in options) throw new Error(`unknown or repeated option: ${item}`);
		const value = values[++i];
		if (!value || value.startsWith("--")) throw new Error(`${item} requires a value`);
		options[key] = value;
	}
	return { positional, options };
}
const pathsFor = (id: string) => new RunPaths(path.resolve(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR), assertTeamId(id));
function count(values: string[], n: number, usage: string): void {
	if (values.length !== n) throw new Error(usage);
}
export async function main(argv: string[]): Promise<number> {
	try {
		const [command, ...values] = argv;
		let result: unknown;
		switch (command) {
			case "start": {
				const { positional, options } = parse(values, ["model"]);
				count(positional, 1, "start [--model provider/model] '<objective>'");
				const id = `task-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
				const paths = pathsFor(id);
				result = { ...createTeam(paths, positional[0], process.cwd(), options.model), goal: loadTask(paths) }; break;
			}
			case "goal": {
				const { positional, options } = parse(values, ["depends"]);
				count(positional, 3, "goal <task> <goal-id> '<objective>' [--depends a,b]");
				result = createTeamGoal(pathsFor(positional[0]), { id: positional[1], objective: positional[2], dependencies: options.depends?.split(",") }); break;
			}
			case "spawn": {
				const { positional, options } = parse(values, ["goal"]);
				count(positional, 2, "spawn <task> [--goal id] '<focus>'");
				const paths = pathsFor(positional[0]);
				result = assignmentView(paths, launchTeamAgent(paths, { goalId: options.goal, focus: positional[1] })); break;
			}
			case "followup": case "resume": {
				const { positional } = parse(values, []);
				count(positional, 3, `${command} <task> <agent-id> '<focus>'`);
				const paths = pathsFor(positional[0]);
				result = assignmentView(paths, launchTeamAgent(paths, { agentId: positional[1], focus: positional[2], mode: command })); break;
			}
			case "watch": {
				const { positional, options } = parse(values, ["since", "idle"]);
				count(positional, 1, "watch <task> [--since seq] [--idle seconds]");
				const controller = new AbortController();
				const cancel = () => controller.abort();
				const outputError = (error: NodeJS.ErrnoException) => {
					if (error.code === "EPIPE") cancel(); else throw error;
				};
				process.on("SIGINT", cancel); process.on("SIGTERM", cancel); process.stdout.on("error", outputError);
				try {
					await watchTeam(pathsFor(positional[0]), {
						since: options.since === undefined ? undefined : Number(options.since),
						idleMs: options.idle === undefined ? undefined : Number(options.idle) * 1000,
						signal: controller.signal, onMessage: message => console.log(JSON.stringify(message)),
					});
				} finally {
					process.off("SIGINT", cancel); process.off("SIGTERM", cancel); process.stdout.off("error", outputError);
				}
				return 0;
			}
			case "status": {
				const { positional } = parse(values, []); count(positional, 1, "status <task>");
				result = teamStatus(pathsFor(positional[0])); break;
			}
			case "inspect": {
				const { positional, options } = parse(values, ["goal", "commitment", "receipt"]);
				count(positional, 1, "inspect <task> [--goal id|--commitment id|--receipt id]");
				if (Object.keys(options).length > 1) throw new Error("inspect accepts at most one selector");
				const paths = pathsFor(positional[0]);
				result = options.commitment ? inspectCommitment(paths, options.commitment)
					: options.receipt ? inspectReceipt(paths, options.receipt) : inspectGoal(paths, options.goal ?? paths.runId); break;
			}
			case "finish": {
				const { positional, options } = parse(values, ["status", "summary", "remaining"]);
				count(positional, 1, "finish <task> --status completed|blocked --summary '<result>' [--remaining '<unfinished work>']");
				result = finishTeam(pathsFor(positional[0]), options.status as "completed" | "blocked", options.summary ?? "", options.remaining ? [options.remaining] : []); break;
			}
			case "stop": {
				const { positional } = parse(values, []);
				if (positional.length < 1 || positional.length > 2) throw new Error("stop <task> [agent-id]");
				const paths = pathsFor(positional[0]);
				await stopTeamAgents(paths, positional[1]); result = teamStatus(paths); break;
			}
			default: throw new Error(`unknown codeteam command: ${command ?? ""}`);
		}
		console.log(JSON.stringify(result)); return 0;
	} catch (error) { console.error(`codeteam: ${(error as Error).message}`); return 1; }
}
if (import.meta.main) process.exit(await main(process.argv.slice(2)));
