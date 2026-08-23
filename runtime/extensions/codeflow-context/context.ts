import { canonicalJson, contentHash } from "../../lib/canonical";
import { handoffHistory, type HandoffRecord, type ReceiptRecord } from "../../lib/handoff";
import { loadGoal } from "../../lib/goals";
import { RunPaths } from "../../lib/paths";
import { goalState } from "../../lib/state";
import { loadTask } from "../../lib/tasks";

export interface ContextSource {
	kind: string;
	ref: string;
	hash: string;
}

export interface BuiltContext {
	xml: string;
	sources: ContextSource[];
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function semanticHandoff(handoff: HandoffRecord): Record<string, unknown> {
	return {
		kind: "handoff",
		seq: handoff.seq,
		id: handoff.id,
		digest: handoff.digest,
	};
}

function semanticReceipt(receipt: ReceiptRecord): Record<string, unknown> {
	return {
		kind: "receipt",
		seq: receipt.seq,
		id: receipt.id,
		handoff_id: receipt.handoff_id,
		status: receipt.status,
		established: receipt.established,
		decisions: receipt.decisions,
		discovered: receipt.discovered,
		unresolved: receipt.unresolved,
		blockers: receipt.blockers,
	};
}

function semanticHistory(paths: RunPaths, goalId: string, excludeHandoffId: string): unknown[] {
	return handoffHistory(paths)
		.filter((view) => view.handoff.goal_id === goalId && view.handoff.id !== excludeHandoffId)
		.flatMap((view) => [
			semanticHandoff(view.handoff),
			...(view.receipt ? [semanticReceipt(view.receipt)] : []),
		])
		.sort((left, right) => (left as { seq: number }).seq - (right as { seq: number }).seq);
}

function source(kind: string, ref: string, value: unknown): ContextSource {
	return { kind, ref, hash: contentHash(value) };
}

function section(name: string, value: unknown): string {
	return `  <${name}>${escapeXml(canonicalJson(value))}</${name}>`;
}

export function buildWorkerContext(
	paths: RunPaths,
	current: HandoffRecord,
	priors: { sharedRules?: string; projectRules?: string } = {},
): BuiltContext {
	const task = loadTask(paths);
	const rootHistory = semanticHistory(paths, task.id, current.id);
	const localHistory = current.goal_id === task.id
		? []
		: semanticHistory(paths, current.goal_id, current.id);
	const currentGoal = current.goal_id === task.id
		? { id: task.id, task_id: task.id, objective: task.objective, dependencies: [] }
		: loadGoal(paths, current.goal_id);
	const reducedState = goalState(paths, current.goal_id);
	const sources = [
		...(priors.sharedRules?.trim() ? [source("shared_rules", "runtime/AGENTS.md", priors.sharedRules)] : []),
		...(priors.projectRules?.trim() ? [source("project_rules", "AGENTS.md", priors.projectRules)] : []),
		source("task", "task.json", task),
		source("root_history", task.id, rootHistory),
		...(current.goal_id === task.id ? [] : [source("goal_history", current.goal_id, localHistory)]),
		...(current.goal_id === task.id ? [] : [source("current_goal", current.goal_id, currentGoal)]),
		source("goal_state", current.goal_id, reducedState),
		source("current_handoff", current.id, current),
	];
	const manifest = sources
		.map((entry) => `    <source kind="${entry.kind}" ref="${escapeXml(entry.ref)}" hash="${entry.hash}" />`)
		.join("\n");
	const sections = [
		...(priors.sharedRules?.trim() ? [section("shared_rules", priors.sharedRules)] : []),
		...(priors.projectRules?.trim() ? [section("project_rules", priors.projectRules)] : []),
		section("task", task),
		section("root_history", rootHistory),
		...(current.goal_id === task.id ? [] : [section("goal_history", localHistory), section("current_goal", currentGoal)]),
		section("goal_state", reducedState),
		section("current_handoff", current),
	];
	return {
		xml: `<codeflow_context version="2">\n  <context_manifest>\n${manifest}\n  </context_manifest>\n${sections.join("\n")}\n</codeflow_context>`,
		sources,
	};
}
