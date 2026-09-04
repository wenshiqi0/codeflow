/**
 * Durable state for one Codemark initial-organization run.
 *
 * Codemark deliberately does not create Codeflow Tasks, Commitments, Worker
 * executions, or Receipts. Stable proposal ids and explicit benchmark markers
 * keep the recorded frontier distinguishable from runtime work.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { contentId } from "../../runtime/lib/canonical";

export const INITIAL_ORGANIZATION_SCHEMA_VERSION = 1;
export const INITIAL_ORGANIZATION_FILENAME = "initial-organization.json";
export const INITIAL_ORGANIZATION_FRONTIER_FILENAME = "frontier.json";

const GOAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type OrganizationStatus = "running" | "completed" | "incomplete" | "failed" | "interrupted";
export type OrganizationTermination =
	| "first_turn_end"
	| "manager_exit"
	| "timeout"
	| "output_truncated"
	| "provider_failure"
	| "interrupted";

export interface CodemarkManager {
	provider: string | null;
	model: string | null;
	thinking_level: string | null;
	prompt_paths: string[];
}

export interface CodemarkLimits {
	timeout_seconds: number | null;
}

export interface CodemarkRootGoal {
	goal_id: string;
	objective: string;
	dependencies: [];
}

export interface CodemarkManagerClaim {
	planning_claim_id: string;
	semantic_seq: number;
	goal_id: string;
	worker_execution_id: string;
	claim_revision: number;
	work: string;
	done_when: string[];
	constraints: string[];
	recorded_at: string;
}

export interface CodemarkGoal {
	sequence: number;
	goal_id: string;
	objective: string;
	dependencies: string[];
	created_at: string;
}

export type CodemarkEffect =
	| { git: string }
	| { file: string }
	| { external: string }
	| { service: Record<string, unknown> };

export interface CodemarkProgressReport {
	planning_receipt_id: string;
	semantic_seq: number;
	summary: string;
	effects: CodemarkEffect[];
	remaining: string[];
	recorded_at: string;
	benchmark: {
		simulated: true;
		canonical_receipt_written: false;
	};
}

export interface CodemarkPreclaimReport {
	report: {
		schema_version: 1;
		task_id: string;
		goal_id: string;
		execution_id: string;
		summary: string;
		remaining: string[];
	};
	benchmark: {
		simulated: true;
		worker_report_written: false;
	};
	recorded_at: string;
}

export interface CodemarkDelegation {
	sequence: number;
	proposal_id: string;
	execution_id: string | null;
	target: "root_goal" | "existing_goal" | "new_goal";
	goal_id: string;
	focus: string;
	readiness: "ready_now" | "waiting_on_dependencies";
	resume_commitment_id: null;
	benchmark: {
		simulated: true;
		execution: "not_started";
	};
	recorded_at: string;
}

export interface CodemarkMetrics {
	delegate_count: number;
	initial_worker_count: number;
	additional_initial_workers: number;
	ready_now_worker_count: number;
	waiting_on_dependencies_count: number;
	root_goal_handoff_count: number;
	new_goal_count: number;
}

export type CodemarkPolicyViolation =
	| "manager_claim_missing"
	| "delegation_missing";

export interface CodemarkAssessment {
	organization_valid: boolean;
	policy_violations: CodemarkPolicyViolation[];
}

export interface CodemarkUsage {
	calls: number;
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	reasoning: number;
	total_tokens: number;
	cost: {
		input: number;
		output: number;
		cache_read: number;
		cache_write: number;
		total: number;
	};
}

interface FlatUsageTotals {
	calls: number;
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	reasoning: number;
	total_tokens: number;
	cost_input: number;
	cost_output: number;
	cost_cache_read: number;
	cost_cache_write: number;
	cost_total: number;
}

export interface InitialOrganization {
	schema_version: 1;
	run_id: string;
	status: OrganizationStatus;
	termination: OrganizationTermination | null;
	issue: string;
	repository: string;
	manager: CodemarkManager;
	limits: CodemarkLimits;
	root_goal: CodemarkRootGoal;
	manager_claim: CodemarkManagerClaim | null;
	manager_progress: CodemarkProgressReport[];
	preclaim_report: CodemarkPreclaimReport | null;
	goals: CodemarkGoal[];
	delegations: CodemarkDelegation[];
	metrics: CodemarkMetrics;
	assessment: CodemarkAssessment | null;
	usage: CodemarkUsage | null;
	diagnostic: string | null;
	timestamps: {
		created_at: string;
		updated_at: string;
		completed_at: string | null;
	};
}

export interface CreateInitialOrganizationInput {
	runId: string;
	issue: string;
	repository: string;
	manager?: {
		provider?: string | null;
		model?: string | null;
		thinking_level?: string | null;
		prompt_paths?: string[];
	};
	limits?: {
		timeout_seconds?: number | null;
	};
	createdAt?: string;
}

export type CodemarkAction =
	| {
		name: "inspect";
		goal_id?: string;
		commitment_id?: string;
		receipt_id?: string;
	}
	| {
		name: "claim";
		work: string;
		done_when?: string[];
		constraints?: string[];
	}
	| {
		name: "report";
		status: "progress" | "completed" | "blocked";
		summary: string;
		effects?: CodemarkEffect[];
		remaining?: string[];
	}
	| {
		name: "delegate";
		goal_id?: string;
		new_goal?: {
			goal_id: string;
			objective: string;
			dependencies?: string[];
		};
		focus: string;
		resume_commitment_id?: string;
	};

export interface OrganizationTransition {
	organization: InitialOrganization;
	result: unknown;
}

export interface FinalizeOrganizationInput {
	termination: OrganizationTermination;
	status?: Exclude<OrganizationStatus, "running">;
	diagnostic?: string;
	now?: string;
	force?: boolean;
}

export class CodemarkOrganizationError extends Error {}

function nonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new CodemarkOrganizationError(`${field} must be a non-empty string`);
	}
	return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
	if (value === undefined || value === null || value === "") return null;
	return nonEmpty(value, field);
}

function stringArray(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new CodemarkOrganizationError(`${field} must be an array`);
	return value.map((entry, index) => nonEmpty(entry, `${field}[${index}]`));
}

function effectArray(value: unknown): CodemarkEffect[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new CodemarkOrganizationError("effects must be an array");
	return value.map((entry, index) => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			throw new CodemarkOrganizationError(`effects[${index}] must be an object`);
		}
		const record = entry as Record<string, unknown>;
		const keys = Object.keys(record);
		if (keys.length !== 1 || !["git", "file", "external", "service"].includes(keys[0])) {
			throw new CodemarkOrganizationError(
				`effects[${index}] must contain exactly one of git, file, external, service`,
			);
		}
		if (keys[0] === "service") {
			if (record.service === null || typeof record.service !== "object" || Array.isArray(record.service)) {
				throw new CodemarkOrganizationError(`effects[${index}].service must be an object`);
			}
		} else {
			nonEmpty(record[keys[0]], `effects[${index}].${keys[0]}`);
		}
		return clone(record) as CodemarkEffect;
	});
}

function normalizeGoalId(value: unknown, field = "goal_id"): string {
	const source = nonEmpty(value, field);
	const id = source
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!GOAL_ID_PATTERN.test(id) || id.startsWith("_")) {
		throw new CodemarkOrganizationError(`goal id must match ${GOAL_ID_PATTERN} and may not start with _: ${source}`);
	}
	return id;
}

function normalizeDependencies(value: unknown): string[] {
	return [...new Set(stringArray(value, "dependencies").map((entry) => normalizeGoalId(entry, "dependency")))].sort();
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function opaqueHex(parts: readonly (string | number)[], length: number): string {
	return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, length);
}

function rootExecutionId(organization: InitialOrganization): string {
	return `exec_${opaqueHex([organization.run_id, "root-manager"], 24)}`;
}

function workerExecutionId(organization: InitialOrganization, sequence: number): string {
	return `exec_${opaqueHex([organization.run_id, "delegation", sequence], 24)}`;
}

function nextSemanticSeq(organization: InitialOrganization): number {
	return Math.max(
		organization.manager_claim?.semantic_seq ?? 0,
		...organization.manager_progress.map((report) => report.semantic_seq),
	) + 1;
}

function commitmentProjection(organization: InitialOrganization): Record<string, unknown> | null {
	const claim = organization.manager_claim;
	if (!claim) return null;
	return {
		id: claim.planning_claim_id,
		schema_version: 1,
		seq: claim.semantic_seq,
		task_id: organization.run_id,
		goal_id: claim.goal_id,
		worker_execution_id: claim.worker_execution_id,
		claim_revision: claim.claim_revision,
		work: claim.work,
		done_when: claim.done_when,
		constraints: claim.constraints,
		parent_commitment_id: null,
	};
}

function progressProjection(
	organization: InitialOrganization,
	report: CodemarkProgressReport,
): Record<string, unknown> {
	const claim = organization.manager_claim;
	if (!claim) throw new CodemarkOrganizationError("progress report has no Manager claim");
	return {
		id: report.planning_receipt_id,
		schema_version: 1,
		seq: report.semantic_seq,
		task_id: organization.run_id,
		goal_id: claim.goal_id,
		commitment_id: claim.planning_claim_id,
		status: "progress",
		summary: report.summary,
		effects: report.effects,
		remaining: report.remaining,
	};
}

function assessOrganization(organization: InitialOrganization): CodemarkAssessment {
	const policyViolations: CodemarkPolicyViolation[] = [];
	if (organization.manager_claim === null) policyViolations.push("manager_claim_missing");
	if (organization.delegations.length === 0) policyViolations.push("delegation_missing");
	return {
		organization_valid: policyViolations.length === 0,
		policy_violations: policyViolations,
	};
}

function frontierPath(runDir: string): string {
	return path.join(runDir, INITIAL_ORGANIZATION_FRONTIER_FILENAME);
}

function publishedArtifactPath(runDir: string): string {
	return path.join(runDir, INITIAL_ORGANIZATION_FILENAME);
}

function writeJsonAtomic(target: string, value: unknown): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const staging = path.join(
		path.dirname(target),
		`.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
	);
	fs.writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	fs.renameSync(staging, target);
}

function assertFiniteNonNegative(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new CodemarkOrganizationError(`${field} must be a finite non-negative number`);
	}
	return value;
}

function assertArtifact(value: unknown): asserts value is InitialOrganization {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new CodemarkOrganizationError("initial organization artifact must be an object");
	}
	const artifact = value as Partial<InitialOrganization>;
	if (artifact.schema_version !== INITIAL_ORGANIZATION_SCHEMA_VERSION) {
		throw new CodemarkOrganizationError("unsupported initial organization schema version");
	}
	if (typeof artifact.run_id !== "string" || artifact.run_id.trim() === "") {
		throw new CodemarkOrganizationError("initial organization run_id is missing");
	}
	if (!(["running", "completed", "incomplete", "failed", "interrupted"] as const).includes(artifact.status as OrganizationStatus)) {
		throw new CodemarkOrganizationError("initial organization status is invalid");
	}
	if (typeof artifact.issue !== "string" || typeof artifact.repository !== "string") {
		throw new CodemarkOrganizationError("initial organization request fields are malformed");
	}
	if (!artifact.root_goal || artifact.root_goal.goal_id !== artifact.run_id) {
		throw new CodemarkOrganizationError("initial organization root_goal is malformed");
	}
	if (
		!Array.isArray(artifact.manager_progress)
		|| !Array.isArray(artifact.goals)
		|| !Array.isArray(artifact.delegations)
	) {
		throw new CodemarkOrganizationError("initial organization frontier is malformed");
	}
	if (!artifact.metrics || !artifact.timestamps) {
		throw new CodemarkOrganizationError("initial organization metadata is malformed");
	}
}

function metrics(organization: Pick<InitialOrganization, "root_goal" | "goals" | "delegations">): CodemarkMetrics {
	const delegateCount = organization.delegations.length;
	const readyNowWorkerCount = organization.delegations.filter(
		(delegation) => delegation.readiness === "ready_now",
	).length;
	return {
		delegate_count: delegateCount,
		initial_worker_count: readyNowWorkerCount,
		additional_initial_workers: Math.max(0, readyNowWorkerCount - 1),
		ready_now_worker_count: readyNowWorkerCount,
		waiting_on_dependencies_count: organization.delegations.filter(
			(delegation) => delegation.readiness === "waiting_on_dependencies",
		).length,
		root_goal_handoff_count: organization.delegations.filter(
			(delegation) => delegation.goal_id === organization.root_goal.goal_id,
		).length,
		new_goal_count: organization.goals.length,
	};
}

function defaultFinalStatus(termination: FinalizeOrganizationInput["termination"]): FinalizeOrganizationInput["status"] {
	if (termination === "first_turn_end") return "completed";
	if (termination === "provider_failure") return "failed";
	if (termination === "interrupted") return "interrupted";
	return "incomplete";
}

function goalMap(organization: InitialOrganization): Map<string, CodemarkGoal> {
	return new Map(organization.goals.map((goal) => [goal.goal_id, goal]));
}

function assertAcyclic(organization: InitialOrganization): void {
	const goals = goalMap(organization);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visited.has(id)) return;
		if (visiting.has(id)) throw new CodemarkOrganizationError(`goal dependency cycle includes ${id}`);
		visiting.add(id);
		for (const dependency of goals.get(id)?.dependencies ?? []) {
			if (!goals.has(dependency)) throw new CodemarkOrganizationError(`unknown goal dependency: ${dependency}`);
			visit(dependency);
		}
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of goals.keys()) visit(id);
}

function requireRunning(organization: InitialOrganization, action: string): void {
	if (organization.status !== "running") {
		throw new CodemarkOrganizationError(
			`${action} is unavailable after Codemark terminated with ${organization.termination ?? organization.status}`,
		);
	}
}

function inspect(organization: InitialOrganization, action: Extract<CodemarkAction, { name: "inspect" }>): unknown {
	const ids = [action.goal_id, action.commitment_id, action.receipt_id].filter(
		(value): value is string => value !== undefined,
	);
	if (ids.length > 1) {
		throw new CodemarkOrganizationError("inspect accepts at most one of goal_id, commitment_id, or receipt_id");
	}
	if (action.receipt_id !== undefined) {
		const report = organization.manager_progress.find(
			(candidate) => candidate.planning_receipt_id === action.receipt_id,
		);
		const commitment = commitmentProjection(organization);
		if (!report || !commitment) {
			throw new CodemarkOrganizationError(`unknown Receipt: ${action.receipt_id}`);
		}
		return { commitment, receipt: progressProjection(organization, report) };
	}
	if (action.commitment_id !== undefined) {
		if (organization.manager_claim?.planning_claim_id !== action.commitment_id) {
			throw new CodemarkOrganizationError(`unknown commitment: ${action.commitment_id}`);
		}
		return {
			commitment: commitmentProjection(organization),
			receipts: organization.manager_progress.map((report) => progressProjection(organization, report)),
		};
	}
	const requested = action.goal_id ?? organization.root_goal.goal_id;
	if (requested === organization.root_goal.goal_id) {
		const claim = organization.manager_claim;
		const commitment = commitmentProjection(organization);
		const receipts = organization.manager_progress.map((report) => progressProjection(organization, report));
		const latest = receipts.at(-1) ?? null;
		const effects = [...new Map(
			organization.manager_progress
				.flatMap((report) => report.effects)
				.map((effect) => [JSON.stringify(effect), effect]),
		).values()];
		return {
			goal: {
				...organization.root_goal,
				status: claim ? "active" : "pending",
				commitment_refs: claim ? [claim.planning_claim_id] : [],
				receipt_refs: organization.manager_progress.map((report) => report.planning_receipt_id),
				summaries: organization.manager_progress.map((report) => report.summary),
				effects,
				remaining: organization.manager_progress.at(-1)?.remaining ?? [],
			},
			commitments: claim && commitment
				? [{
					commitment,
					status: "running",
					receipt_count: receipts.length,
					latest,
				}]
				: [],
		};
	}
	const id = normalizeGoalId(requested);
	const goal = goalMap(organization).get(id);
	if (!goal) throw new CodemarkOrganizationError(`unknown goal: ${id}`);
	return {
		goal: {
			goal_id: goal.goal_id,
			objective: goal.objective,
			dependencies: goal.dependencies,
			status: goal.dependencies.length === 0 ? "pending" : "waiting",
			commitment_refs: [],
			receipt_refs: [],
			summaries: [],
			effects: [],
			remaining: [],
		},
		commitments: [],
	};
}

export function createInitialOrganization(
	runDir: string,
	input: CreateInitialOrganizationInput,
): InitialOrganization {
	const target = frontierPath(runDir);
	const runId = nonEmpty(input.runId, "runId");
	const issue = nonEmpty(input.issue, "issue");
	const repository = nonEmpty(input.repository, "repository");
	if (fs.existsSync(target)) {
		const existing = readInitialOrganization(runDir);
		if (existing.run_id !== runId || existing.issue !== issue || existing.repository !== repository) {
			throw new CodemarkOrganizationError("initial organization already exists for a different request");
		}
		return existing;
	}
	if (fs.existsSync(publishedArtifactPath(runDir))) {
		throw new CodemarkOrganizationError("initial organization is already published");
	}
	const createdAt = input.createdAt ?? new Date().toISOString();
	const timeout = input.limits?.timeout_seconds ?? null;
	if (timeout !== null) assertFiniteNonNegative(timeout, "limits.timeout_seconds");
	const organization: InitialOrganization = {
		schema_version: INITIAL_ORGANIZATION_SCHEMA_VERSION,
		run_id: runId,
		status: "running",
		termination: null,
		issue,
		repository,
		manager: {
			provider: optionalString(input.manager?.provider, "manager.provider"),
			model: optionalString(input.manager?.model, "manager.model"),
			thinking_level: optionalString(input.manager?.thinking_level, "manager.thinking_level"),
			prompt_paths: stringArray(input.manager?.prompt_paths, "manager.prompt_paths"),
		},
		limits: { timeout_seconds: timeout },
		root_goal: { goal_id: runId, objective: issue, dependencies: [] },
		manager_claim: null,
		manager_progress: [],
		preclaim_report: null,
		goals: [],
		delegations: [],
		metrics: {
			delegate_count: 0,
			initial_worker_count: 0,
			additional_initial_workers: 0,
			ready_now_worker_count: 0,
			waiting_on_dependencies_count: 0,
			root_goal_handoff_count: 0,
			new_goal_count: 0,
		},
		assessment: null,
		usage: null,
		diagnostic: null,
		timestamps: {
			created_at: createdAt,
			updated_at: createdAt,
			completed_at: null,
		},
	};
	writeInitialOrganization(runDir, organization);
	return organization;
}

export function readInitialOrganization(runDir: string): InitialOrganization {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(frontierPath(runDir), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new CodemarkOrganizationError(`initial organization frontier does not exist: ${frontierPath(runDir)}`);
		}
		throw error;
	}
	assertArtifact(parsed);
	assertAcyclic(parsed);
	return parsed;
}

export function writeInitialOrganization(runDir: string, organization: InitialOrganization): InitialOrganization {
	assertArtifact(organization);
	assertAcyclic(organization);
	if (fs.existsSync(publishedArtifactPath(runDir))) {
		throw new CodemarkOrganizationError("initial organization is already published");
	}
	writeJsonAtomic(frontierPath(runDir), organization);
	return organization;
}

/**
 * Atomically promote the private frontier to one immutable terminal artifact
 * after host-side usage has been attached. Until this rename the Manager
 * extension only mutates the private path, so readers can never observe a
 * completed public artifact whose usage is still null.
 */
export function publishInitialOrganization(runDir: string): InitialOrganization {
	const target = publishedArtifactPath(runDir);
	if (fs.existsSync(target)) {
		throw new CodemarkOrganizationError("initial organization is already published");
	}
	const organization = readInitialOrganization(runDir);
	if (
		organization.status === "running"
		|| organization.termination === null
		|| organization.timestamps.completed_at === null
	) {
		throw new CodemarkOrganizationError("cannot publish a non-terminal initial organization");
	}
	if (organization.usage === null) {
		throw new CodemarkOrganizationError("cannot publish an initial organization without usage");
	}
	fs.renameSync(frontierPath(runDir), target);
	return organization;
}

export function transitionOrganization(
	current: InitialOrganization,
	action: CodemarkAction,
	now = new Date().toISOString(),
): OrganizationTransition {
	assertArtifact(current);
	assertAcyclic(current);
	const organization = clone(current);

	switch (action.name) {
		case "inspect":
			return { organization, result: inspect(organization, action) };
		case "claim": {
			requireRunning(organization, action.name);
			if (organization.preclaim_report !== null) {
				throw new CodemarkOrganizationError("a Worker that reported a blocker cannot claim in the same execution");
			}
			if (organization.manager_claim !== null) {
				throw new CodemarkOrganizationError(
					`current Commitment is still open: ${organization.manager_claim.planning_claim_id}`,
				);
			}
			const semanticSeq = nextSemanticSeq(organization);
			const workerExecution = rootExecutionId(organization);
			const work = nonEmpty(action.work, "work");
			const doneWhen = stringArray(action.done_when, "done_when");
			const constraints = stringArray(action.constraints, "constraints");
			const commitmentContent = {
				schema_version: 1 as const,
				seq: semanticSeq,
				task_id: organization.run_id,
				goal_id: organization.root_goal.goal_id,
				worker_execution_id: workerExecution,
				claim_revision: 1,
				work,
				done_when: doneWhen,
				constraints,
				parent_commitment_id: null,
			};
			const claim: CodemarkManagerClaim = {
				planning_claim_id: contentId("c", commitmentContent),
				semantic_seq: semanticSeq,
				goal_id: organization.root_goal.goal_id,
				worker_execution_id: workerExecution,
				claim_revision: 1,
				work,
				done_when: doneWhen,
				constraints,
				recorded_at: now,
			};
			organization.manager_claim = claim;
			organization.timestamps.updated_at = now;
			return {
				organization,
				result: { commitment_id: claim.planning_claim_id, goal_id: claim.goal_id },
			};
		}
		case "report": {
			requireRunning(organization, action.name);
			if (organization.manager_claim === null) {
				if (action.status !== "blocked") {
					throw new CodemarkOrganizationError("a pre-claim report must be blocked");
				}
				if (organization.preclaim_report !== null) {
					throw new CodemarkOrganizationError(`execution already reported: ${rootExecutionId(organization)}`);
				}
				const report = {
					schema_version: 1 as const,
					task_id: organization.run_id,
					goal_id: organization.root_goal.goal_id,
					execution_id: rootExecutionId(organization),
					summary: nonEmpty(action.summary, "summary"),
					remaining: stringArray(action.remaining, "remaining"),
				};
				organization.preclaim_report = {
					report,
					benchmark: { simulated: true, worker_report_written: false },
					recorded_at: now,
				};
				organization.timestamps.updated_at = now;
				return { organization, result: report };
			}
			if (action.status !== "progress") {
				throw new CodemarkOrganizationError(
					"terminal Root Receipt requires at least one Child Worker Commitment",
				);
			}
			const semanticSeq = nextSemanticSeq(organization);
			const summary = nonEmpty(action.summary, "summary");
			const effects = effectArray(action.effects);
			const remaining = stringArray(action.remaining, "remaining");
			const receiptContent = {
				schema_version: 1 as const,
				seq: semanticSeq,
				task_id: organization.run_id,
				goal_id: organization.manager_claim.goal_id,
				commitment_id: organization.manager_claim.planning_claim_id,
				status: "progress" as const,
				summary,
				effects,
				remaining,
			};
			const report: CodemarkProgressReport = {
				planning_receipt_id: contentId("r", receiptContent),
				semantic_seq: semanticSeq,
				summary,
				effects,
				remaining,
				recorded_at: now,
				benchmark: { simulated: true, canonical_receipt_written: false },
			};
			organization.manager_progress.push(report);
			organization.timestamps.updated_at = now;
			return {
				organization,
				result: { receipt_id: report.planning_receipt_id, status: "progress" },
			};
		}
		case "delegate": {
			requireRunning(organization, action.name);
			if (organization.manager_claim === null) {
				throw new CodemarkOrganizationError("delegate requires the Root Worker to claim its own Commitment first");
			}
			if (action.resume_commitment_id !== undefined) {
				throw new CodemarkOrganizationError(`unknown commitment: ${action.resume_commitment_id}`);
			}
			if ((action.goal_id === undefined) === (action.new_goal === undefined)) {
				throw new CodemarkOrganizationError("delegate requires exactly one of goal_id or new_goal");
			}
			const focus = nonEmpty(action.focus, "focus");
			let target: CodemarkDelegation["target"];
			let goalId: string;
			if (action.new_goal !== undefined) {
				goalId = normalizeGoalId(action.new_goal.goal_id);
				if (goalId === organization.root_goal.goal_id) {
					throw new CodemarkOrganizationError("run id is already the root Goal");
				}
				const objective = nonEmpty(action.new_goal.objective, "objective");
				const dependencies = normalizeDependencies(action.new_goal.dependencies);
				for (const dependency of dependencies) {
					if (dependency === goalId) {
						throw new CodemarkOrganizationError(`goal ${goalId} cannot depend on itself`);
					}
					if (!organization.goals.some((goal) => goal.goal_id === dependency)) {
						throw new CodemarkOrganizationError(`unknown goal dependency: ${dependency}`);
					}
				}
				const existing = goalMap(organization).get(goalId);
				if (existing) {
					if (
						existing.objective !== objective
						|| JSON.stringify(existing.dependencies) !== JSON.stringify(dependencies)
					) {
						throw new CodemarkOrganizationError(`goal already exists with different content: ${goalId}`);
					}
					target = "existing_goal";
				} else {
					organization.goals.push({
						sequence: organization.goals.length + 1,
						goal_id: goalId,
						objective,
						dependencies,
						created_at: now,
					});
					target = "new_goal";
				}
			} else {
				const requested = nonEmpty(action.goal_id, "goal_id");
				if (requested === organization.root_goal.goal_id) {
					goalId = requested;
					target = "root_goal";
				} else {
					goalId = normalizeGoalId(requested);
					if (!goalMap(organization).has(goalId)) {
						throw new CodemarkOrganizationError(`unknown goal: ${goalId}`);
					}
					target = "existing_goal";
				}
			}
			assertAcyclic(organization);
			const sequence = organization.delegations.length + 1;
			const dependencies = goalId === organization.root_goal.goal_id
				? organization.root_goal.dependencies
				: goalMap(organization).get(goalId)?.dependencies ?? [];
			const readiness: CodemarkDelegation["readiness"] = dependencies.length === 0
				? "ready_now"
				: "waiting_on_dependencies";
			const delegation: CodemarkDelegation = {
				sequence,
				proposal_id: `proposal_${String(sequence).padStart(3, "0")}`,
				execution_id: readiness === "ready_now" ? workerExecutionId(organization, sequence) : null,
				target,
				goal_id: goalId,
				focus,
				readiness,
				resume_commitment_id: null,
				benchmark: { simulated: true, execution: "not_started" },
				recorded_at: now,
			};
			organization.delegations.push(delegation);
			organization.metrics = metrics(organization);
			organization.timestamps.updated_at = now;
			return {
				organization,
				result: {
					goal_id: delegation.goal_id,
					status: readiness === "ready_now" ? "running" : "waiting",
					execution_id: delegation.execution_id,
				},
			};
		}
		default:
			throw new CodemarkOrganizationError("unknown collaborate action");
	}
}

export function applyOrganizationAction(
	runDir: string,
	action: CodemarkAction,
	now?: string,
): OrganizationTransition {
	const transition = transitionOrganization(readInitialOrganization(runDir), action, now);
	writeInitialOrganization(runDir, transition.organization);
	return transition;
}

export function finalizeOrganization(
	runDir: string,
	input: FinalizeOrganizationInput,
): InitialOrganization {
	const organization = clone(readInitialOrganization(runDir));
	if (organization.status !== "running" && !input.force) return organization;
	const now = input.now ?? new Date().toISOString();
	organization.status = input.status ?? defaultFinalStatus(input.termination) ?? "incomplete";
	organization.termination = input.termination;
	organization.assessment = assessOrganization(organization);
	organization.diagnostic = input.diagnostic === undefined
		? null
		: nonEmpty(input.diagnostic, "diagnostic").slice(0, 2_000);
	organization.timestamps.updated_at = now;
	organization.timestamps.completed_at = now;
	writeInitialOrganization(runDir, organization);
	return organization;
}

export function attachOrganizationUsage(
	runDir: string,
	usage: CodemarkUsage | FlatUsageTotals | { total: CodemarkUsage | FlatUsageTotals },
	now = new Date().toISOString(),
): InitialOrganization {
	const organization = clone(readInitialOrganization(runDir));
	const candidate = "total" in usage ? usage.total : usage;
	const cost = "cost" in candidate
		? candidate.cost
		: {
			input: candidate.cost_input,
			output: candidate.cost_output,
			cache_read: candidate.cost_cache_read,
			cache_write: candidate.cost_cache_write,
			total: candidate.cost_total,
		};
	organization.usage = {
		calls: assertFiniteNonNegative(candidate.calls, "usage.calls"),
		input: assertFiniteNonNegative(candidate.input, "usage.input"),
		output: assertFiniteNonNegative(candidate.output, "usage.output"),
		cache_read: assertFiniteNonNegative(candidate.cache_read, "usage.cache_read"),
		cache_write: assertFiniteNonNegative(candidate.cache_write, "usage.cache_write"),
		reasoning: assertFiniteNonNegative(candidate.reasoning, "usage.reasoning"),
		total_tokens: assertFiniteNonNegative(candidate.total_tokens, "usage.total_tokens"),
		cost: {
			input: assertFiniteNonNegative(cost.input, "usage.cost.input"),
			output: assertFiniteNonNegative(cost.output, "usage.cost.output"),
			cache_read: assertFiniteNonNegative(cost.cache_read, "usage.cost.cache_read"),
			cache_write: assertFiniteNonNegative(cost.cache_write, "usage.cost.cache_write"),
			total: assertFiniteNonNegative(cost.total, "usage.cost.total"),
		},
	};
	organization.timestamps.updated_at = now;
	writeInitialOrganization(runDir, organization);
	return organization;
}
