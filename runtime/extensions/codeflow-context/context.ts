/** Assemble a fresh, pull-first, Goal-scoped working set for every Worker. */

import { canonicalJson, contentHash } from "../../lib/canonical";
import { commitmentHistory, type CommitmentRecord, loadReceiptChain } from "../../lib/commitment";
import type { ContextSectionShape, WorkerContextShape } from "../../lib/observability/prompt-shape";
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
	shape: WorkerContextShape;
}

export const CONTEXT_TEXT_LIMIT = 600;
const CONTEXT_TEXT_EDGE = 300;
const CONTEXT_ELLIPSIS = "…";

/** Bound model-visible text without changing the durable record used for recall. */
export function truncateContextText(value: string): string {
	const characters = [...value];
	if (characters.length <= CONTEXT_TEXT_LIMIT) return value;
	return `${characters.slice(0, CONTEXT_TEXT_EDGE).join("")}${CONTEXT_ELLIPSIS}${characters.slice(-CONTEXT_TEXT_EDGE).join("")}`;
}

function boundedValue(value: unknown): unknown {
	if (typeof value === "string") return truncateContextText(value);
	if (Array.isArray(value)) return value.map(boundedValue);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundedValue(item)]));
	}
	return value;
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
	return escapeXml(value).replace(/"/g, "&quot;");
}

interface ContextEntry {
	kind: string;
	ref: string;
	value: unknown;
	format?: "json" | "text";
	attributes?: Record<string, string>;
}

function renderSection(entry: ContextEntry): { xml: string; shape: ContextSectionShape } {
	const value = boundedValue(entry.value);
	const attributes = Object.entries(entry.attributes ?? {})
		.map(([name, content]) => ` ${name}="${escapeXmlAttribute(content)}"`)
		.join("");
	const content = entry.format === "text" ? String(value) : canonicalJson(value);
	const xml = `  <${entry.kind}${attributes}>${escapeXml(content)}</${entry.kind}>`;
	return {
		xml,
		shape: { kind: entry.kind, hash: contentHash({ attributes: entry.attributes ?? {}, value }), chars: xml.length },
	};
}

function currentGoalContext(state: ReturnType<typeof goalState>) {
	const { commitment_refs: _commitments, receipt_refs: _receipts, summaries: _summaries, ...current } = state;
	return current;
}

function buildContext(entries: ContextEntry[]): BuiltContext {
	const sections = entries.map(renderSection);
	const sources = entries.map((entry, index) => ({ kind: entry.kind, ref: entry.ref, hash: sections[index].shape.hash }));
	const xml = `<codeflow_context version="7">\n${sections.map((entry) => entry.xml).join("\n")}\n</codeflow_context>`;
	return {
		xml,
		sources,
		shape: {
			hash: contentHash(xml),
			chars: xml.length,
			sections: sections.map((entry) => entry.shape),
		},
	};
}

/**
 * Render exactly the context produced for a fresh Root without requiring a
 * durable Codeflow run. Benchmark harnesses use this pure projection so their
 * model-visible bootstrap cannot drift from production.
 */
export function buildFreshRootContext(
	goalId: string,
	objective: string,
	priors: { projectRules?: string } = {},
): BuiltContext {
	const rootState = {
		goal_id: goalId,
		objective,
		dependencies: [],
		status: "pending" as const,
		commitment_refs: [],
		receipt_refs: [],
		summaries: [],
		effects: [],
		remaining: [],
	};
	const bootstrap = { goal_id: goalId, focus: null };
	return buildContext([
		...(priors.projectRules?.trim()
			? [{ kind: "project_rules", ref: "AGENTS.md", value: priors.projectRules, format: "text" as const }]
			: []),
		{ kind: "goal", ref: goalId, value: currentGoalContext(rootState) },
		{ kind: "worker_bootstrap", ref: goalId, value: bootstrap },
	]);
}

/**
 * Pull-first context: reduced root and current Goal state, bounded summaries
 * of prior Goal-scoped Commitments and Receipts, the current Commitment, and
 * its folded Receipt state. Record ids recall full durable content through
 * `collaborate inspect`.
 */
export function buildWorkerContext(
	paths: RunPaths,
	goalId: string,
	current: CommitmentRecord | null,
	priors: {
		projectRules?: string;
		workFocus?: string;
	} = {},
): BuiltContext {
	const task = loadTask(paths);
	const rootState = goalState(paths, task.id);
	const currentGoalState = goalId === task.id
		? rootState
		: goalState(paths, goalId);
	const folded = current ? loadReceiptChain(paths, current.id) : null;
	const foldedState = folded ? {
		summaries: folded.summaries,
		effects: folded.effects,
		remaining: folded.remaining,
		head: {
			receipt_id: folded.head?.id ?? null,
			seq: folded.head?.seq ?? null,
			status: folded.head?.status ?? null,
			terminal: folded.terminal !== null,
			receipt_count: folded.receipts.length,
		},
	} : null;
	const bootstrap = current ? null : {
		goal_id: goalId,
		focus: priors.workFocus?.trim() || null,
	};
	const historyEntries: Array<ContextEntry & { seq: number }> = commitmentHistory(paths)
		.filter((view) => view.commitment.goal_id === goalId && view.commitment.id !== current?.id)
		.flatMap((view) => [
			{
				kind: "commit",
				ref: view.commitment.id,
				value: view.commitment.work,
				format: "text" as const,
				attributes: { id: view.commitment.id },
				seq: view.commitment.seq,
			},
			...view.folded.receipts.map((receipt) => ({
				kind: "receipt",
				ref: receipt.id,
				value: receipt.summary,
				format: "text" as const,
				attributes: { id: receipt.id },
				seq: receipt.seq,
			})),
		])
		.sort((left, right) => left.seq - right.seq || left.ref.localeCompare(right.ref));
	const entries: ContextEntry[] = [
		...(priors.projectRules?.trim() ? [{ kind: "project_rules", ref: "AGENTS.md", value: priors.projectRules, format: "text" as const }] : []),
		...(goalId === task.id ? [] : [{ kind: "root_goal", ref: task.id, value: rootState }]),
		{ kind: "goal", ref: goalId, value: currentGoalContext(currentGoalState) },
		...historyEntries.map(({ seq: _, ...entry }) => entry),
		...(bootstrap ? [{ kind: "worker_bootstrap", ref: goalId, value: bootstrap }] : []),
		...(current ? [{ kind: "current_commitment", ref: current.id, value: current }] : []),
		...(current && foldedState ? [{ kind: "current_commitment_folded", ref: current.id, value: foldedState }] : []),
	];
	return buildContext(entries);
}
