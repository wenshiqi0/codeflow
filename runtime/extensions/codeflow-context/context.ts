/** Assemble a fresh, pull-first, Goal-scoped working set for every Handoff. */

import { canonicalJson, contentHash } from "../../lib/canonical";
import { type HandoffRecord, loadReceiptChain } from "../../lib/handoff";
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

function source(kind: string, ref: string, value: unknown): ContextSource {
	return { kind, ref, hash: contentHash(value) };
}

function section(name: string, value: unknown): string {
	return `  <${name}>${escapeXml(canonicalJson(value))}</${name}>`;
}

/**
 * Pull-first context: the Task, reduced root and current Goal state, the
 * current Handoff, its folded Receipt state, and Receipt head metadata.
 *
 * Full Handoff/Receipt history is never injected; it is available only
 * through the explicit `recall` tools.
 */
export function buildWorkerContext(
	paths: RunPaths,
	current: HandoffRecord,
	priors: { sharedRules?: string; projectRules?: string } = {},
): BuiltContext {
	const task = loadTask(paths);
	const folded = loadReceiptChain(paths, current.id);
	const head = folded.head;
	const receiptHead = {
		receipt_id: head?.id ?? null,
		seq: head?.seq ?? null,
		status: head?.status ?? null,
		terminal: folded.terminal !== null,
		receipt_count: folded.receipts.length,
	};
	const foldedState = {
		facts: {
			established: folded.established,
			decisions: folded.decisions,
			discovered: folded.discovered,
			unresolved: folded.unresolved,
			blockers: folded.blockers,
		},
		head: receiptHead,
	};
	const rootState = goalState(paths, task.id);
	const currentGoalState = current.goal_id === task.id
		? rootState
		: goalState(paths, current.goal_id);
	const sources = [
		...(priors.sharedRules?.trim() ? [source("shared_rules", "runtime/AGENTS.md", priors.sharedRules)] : []),
		...(priors.projectRules?.trim() ? [source("project_rules", "AGENTS.md", priors.projectRules)] : []),
		source("task", "task.json", task),
		source("root_goal_state", task.id, rootState),
		...(current.goal_id === task.id ? [] : [source("current_goal_state", current.goal_id, currentGoalState)]),
		source("current_handoff", current.id, current),
		source("current_handoff_folded", current.id, foldedState),
	];
	const manifest = sources
		.map((entry) => `    <source kind="${entry.kind}" ref="${escapeXml(entry.ref)}" hash="${entry.hash}" />`)
		.join("\n");
	const sections = [
		...(priors.sharedRules?.trim() ? [section("shared_rules", priors.sharedRules)] : []),
		...(priors.projectRules?.trim() ? [section("project_rules", priors.projectRules)] : []),
		section("task", task),
		section("root_goal_state", rootState),
		...(current.goal_id === task.id ? [] : [section("current_goal_state", currentGoalState)]),
		section("current_handoff", current),
		section("current_handoff_folded", foldedState),
	];
	return {
		xml: `<codeflow_context version="3">\n  <context_manifest>\n${manifest}\n  </context_manifest>\n${sections.join("\n")}\n</codeflow_context>`,
		sources,
	};
}
