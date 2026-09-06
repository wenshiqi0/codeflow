import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	claimCommitment,
	goalClaimRevision,
	loadTerminalReceipt,
	submitReceipt,
} from "../../lib/commitment";
import { loadWorkerReport, writeWorkerReport } from "../../lib/executions";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import { inspectCommitment, inspectGoal, inspectReceipt } from "../../lib/inspection";
import { goalState } from "../../lib/state";
import { validateTeamAgentStartup } from "../../lib/team";
import { isAlive } from "../../lib/watchdog";

const ACTIONS = ["inspect", "claim", "report"] as const;
type CollaborateAction = (typeof ACTIONS)[number];

function currentRun(): RunPaths {
	const taskId = process.env.CODEFLOW_RUN_ID;
	if (!taskId) throw new Error("collaborate requires a Codeflow Task");
	return new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, taskId);
}

function currentGoal(paths: RunPaths): string {
	return process.env.CODEFLOW_GOAL_ID ?? paths.runId;
}

function currentExecution(): string {
	const executionId = process.env.CODEFLOW_EXECUTION_ID;
	if (!executionId) throw new Error("collaborate requires an Agent execution");
	return executionId;
}

function dependenciesCompleted(paths: RunPaths, goalId: string): boolean {
	if (goalId === paths.runId) return true;
	return goalState(paths, goalId).dependencies.every(
		(dependency) => goalState(paths, dependency).status === "completed",
	);
}

function result(value: unknown, details?: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details,
	};
}

const StringArray = Type.Array(Type.String({ minLength: 1 }));
const Effect = Type.Union([
	Type.Object({ git: Type.String({ minLength: 1 }) }),
	Type.Object({ file: Type.String({ minLength: 1 }) }),
	Type.Object({ external: Type.String({ minLength: 1 }) }),
	Type.Object({ service: Type.Record(Type.String(), Type.Unknown()) }),
]);
const ReceiptStatus = Type.Union([
	Type.Literal("progress"),
	Type.Literal("completed"),
	Type.Literal("blocked"),
]);

const ACTION_SCHEMAS = {
	inspect: Type.Object({
		name: Type.Literal("inspect"),
		goal_id: Type.Optional(Type.String({ minLength: 1 })),
		commitment_id: Type.Optional(Type.String({ minLength: 1 })),
		receipt_id: Type.Optional(Type.String({ minLength: 1 })),
	}, { additionalProperties: false, description: "Recall a Goal, Commitment, or Receipt by id. Omit ids for the current Goal." }),
	claim: Type.Object({
		name: Type.Literal("claim"),
		work: Type.String({ minLength: 1, maxLength: 600 }),
		done_when: Type.Optional(StringArray),
		constraints: Type.Optional(StringArray),
	}, { additionalProperties: false, description: "Create this Agent's bounded Commitment." }),
	report: Type.Object({
		name: Type.Literal("report"),
		status: ReceiptStatus,
		summary: Type.String({ minLength: 1 }),
		effects: Type.Optional(Type.Array(Effect)),
		remaining: Type.Optional(StringArray),
	}, { additionalProperties: false, description: "Report progress, completion, or a blocker. Before claim, only blocked is valid." }),
} as const;

function parameters() {
	return Type.Object({
		action: Type.Union(ACTIONS.map((action) => ACTION_SCHEMAS[action])),
	}, { additionalProperties: false });
}

/** A Pi execution must not outlive the outer runner that owns its assignment. */
export function registerTeamRunnerSupervisor(
	pi: Pick<ExtensionAPI, "on">,
	runnerPid: number,
	options: {
		pid?: number;
		alive?: (pid: number) => boolean;
		kill?: (pid: number, signal: NodeJS.Signals) => unknown;
		intervalMs?: number;
		killGraceMs?: number;
	} = {},
): () => void {
	const pid = options.pid ?? process.pid;
	if (!Number.isSafeInteger(runnerPid) || runnerPid <= 0 || runnerPid > 2_147_483_647 || runnerPid === pid) {
		throw new Error("a Team Agent requires its valid, distinct outer runner PID");
	}
	const alive = options.alive ?? isAlive;
	const kill = options.kill ?? ((target, signal) => process.kill(target, signal));
	let escalation: ReturnType<typeof setTimeout> | undefined;
	const signalGroup = (signal: NodeJS.Signals) => {
		try { kill(-pid, signal); }
		catch { kill(pid, signal); }
	};
	const timer = setInterval(() => {
		if (alive(runnerPid)) return;
		clearInterval(timer);
		console.error("Codeflow outer runner exited; stopping its orphaned Agent process group");
		// Pi's SIGTERM handler also reaps its separately detached bash groups.
		// A direct SIGKILL would bypass that cleanup and strand tool processes.
		escalation = setTimeout(() => signalGroup("SIGKILL"), options.killGraceMs ?? 5_000);
		escalation.unref();
		signalGroup("SIGTERM");
	}, options.intervalMs ?? 1_000);
	timer.unref();
	const dispose = () => { clearInterval(timer); if (escalation) clearTimeout(escalation); };
	// Once orphan cleanup began, shutdown must not cancel its hard backstop.
	pi.on("session_shutdown", () => clearInterval(timer));
	return dispose;
}

export default function (pi: ExtensionAPI) {
	if (process.env.CODEFLOW_TEAM_AGENT_ID) {
		try {
			const startup = validateTeamAgentStartup(currentRun(), process.env.CODEFLOW_TEAM_AGENT_ID, currentExecution());
			if (startup.commitment_id) process.env.CODEFLOW_COMMITMENT_ID = startup.commitment_id;
			else delete process.env.CODEFLOW_COMMITMENT_ID;
			registerTeamRunnerSupervisor(pi, Number(process.env.CODEFLOW_TEAM_RUNNER_PID));
			// Pi can otherwise continue after an extension load error. Never fall
			// back to an untracked native shell in an outer-managed execution.
			pi.on("before_agent_start", () => {
				if (process.env.CODEFLOW_TEAM_SHELL_READY !== currentExecution()) {
					console.error("Codeflow Agent startup rejected: tracked shell extension did not initialize");
					process.exit(1);
				}
			});
		}
		catch (error) {
			// The outer runner owns admission and PID publication. An extension
			// load error alone is not fail-closed: Pi may continue without it.
			console.error(`Codeflow Agent startup rejected: ${String(error)}`);
			process.exit(1);
		}
	}
	pi.registerTool({
		name: "collaborate",
		label: "Collaborate",
		description: "Execute one assigned Goal: inspect durable evidence, claim bounded work, and report progress or a terminal Receipt. Task and Agent control commands are available through codeteam, not this tool.",
		parameters: parameters(),
		async execute(_id, rawParams) {
			const params = (rawParams as { action: Record<string, unknown> }).action;
			const action = params.name as CollaborateAction;
			if (!(ACTIONS as readonly string[]).includes(action)) {
				throw new Error(`unknown collaborate action: ${String(action)}`);
			}
			const paths = currentRun();
			switch (action) {
				case "inspect": {
					const ids = [params.goal_id, params.commitment_id, params.receipt_id].filter(Boolean);
					if (ids.length > 1) throw new Error("inspect accepts at most one of goal_id, commitment_id, or receipt_id");
					if (params.receipt_id) return result(inspectReceipt(paths, params.receipt_id as string));
					if (params.commitment_id) return result(inspectCommitment(paths, params.commitment_id as string));
					return result(inspectGoal(paths, (params.goal_id as string | undefined) ?? currentGoal(paths)));
				}
				case "claim": {
					const executionId = currentExecution();
					const goalId = currentGoal(paths);
					if (!dependenciesCompleted(paths, goalId)) throw new Error(`goal dependencies are not completed: ${goalId}`);
					if (loadWorkerReport(paths, executionId)) throw new Error("an Agent that reported a blocker cannot claim in the same execution");
					const currentId = process.env.CODEFLOW_COMMITMENT_ID;
					if (currentId && !loadTerminalReceipt(paths, currentId)) {
						throw new Error(`current Commitment is still open: ${currentId}`);
					}
					const commitment = claimCommitment(paths, {
						goalId,
						workerExecutionId: executionId,
						basedOnRevision: goalClaimRevision(paths, goalId),
						work: params.work as string,
						doneWhen: params.done_when as string[] | undefined,
						constraints: params.constraints as string[] | undefined,
						parentCommitmentId: null,
					});
					process.env.CODEFLOW_COMMITMENT_ID = commitment.id;
					return result({ commitment_id: commitment.id, goal_id: commitment.goal_id });
				}
				case "report": {
					const commitmentId = process.env.CODEFLOW_COMMITMENT_ID;
					const status = params.status as Parameters<typeof submitReceipt>[1]["status"];
					if (!commitmentId) {
						if (status !== "blocked") throw new Error("a pre-claim report must be blocked");
						return result(writeWorkerReport(paths, {
							goal_id: currentGoal(paths),
							execution_id: currentExecution(),
							summary: params.summary as string,
							remaining: (params.remaining as string[] | undefined) ?? [],
						}));
					}
					const receipt = submitReceipt(paths, {
						commitmentId,
						status,
						summary: params.summary as string,
						effects: params.effects as Parameters<typeof submitReceipt>[1]["effects"],
						remaining: params.remaining as string[] | undefined,
					});
					return result({ receipt_id: receipt.id, status: receipt.status });
				}
			}
		},
	});
}
