import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
	CodemarkOrganizationError,
	applyOrganizationAction,
	attachOrganizationUsage,
	createInitialOrganization,
	finalizeOrganization,
	publishInitialOrganization,
	readInitialOrganization,
	transitionOrganization,
} from "../../codemark/lib/organization";
import { cleanupTmpDirs, makeTmpDir } from "./helpers";

afterEach(cleanupTmpDirs);

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-04T00:00:01.000Z";
const T2 = "2026-09-04T00:00:02.000Z";
const T3 = "2026-09-04T00:00:03.000Z";
const T4 = "2026-09-04T00:00:04.000Z";

function createRun() {
	const runDir = makeTmpDir("codemark-organization-");
	const organization = createInitialOrganization(runDir, {
		runId: "codemark-test-run",
		issue: "Repair the parser without widening the public API",
		repository: "/workspace/repository",
		manager: {
			provider: "test-provider",
			model: "test-manager",
			thinking_level: "high",
			prompt_paths: ["references/manager.md"],
		},
		limits: { timeout_seconds: 30 },
		createdAt: T0,
	});
	return { runDir, organization };
}

function claim(runDir: string) {
	return applyOrganizationAction(runDir, {
		name: "claim",
		work: "Inspect the Issue and define the initial organization frontier",
		done_when: ["the initial delegations are recorded"],
		constraints: ["do not implement the Issue"],
	}, T1);
}

describe("Codemark initial organization", () => {
	test("records claim, multiple delegates, and completes on the first wait", () => {
		const { runDir } = createRun();
		const claimed = claim(runDir);
		expect(claimed.result).toMatchObject({ goal_id: "codemark-test-run" });
		expect((claimed.result as { commitment_id: string }).commitment_id).toMatch(/^c_[0-9a-f]{64}$/);

		const root = applyOrganizationAction(runDir, {
			name: "delegate",
			goal_id: "codemark-test-run",
			focus: "trace the failing behavior and identify the narrow repair",
		}, T2);
		expect(root.result).toMatchObject({
			goal_id: "codemark-test-run",
			status: "running",
		});
		const rootExecutionId = (root.result as { execution_id: string }).execution_id;
		expect(rootExecutionId).toMatch(/^exec_[0-9a-f]{24}$/);

		const child = applyOrganizationAction(runDir, {
			name: "delegate",
			new_goal: {
				goal_id: "regression-tests",
				objective: "Specify regression coverage for the repaired parser",
			},
			focus: "design focused tests independently from the implementation",
		}, T3);
		expect(child.result).toMatchObject({
			goal_id: "regression-tests",
			status: "running",
		});
		const childExecutionId = (child.result as { execution_id: string }).execution_id;
		expect(childExecutionId).toMatch(/^exec_[0-9a-f]{24}$/);
		expect(childExecutionId).not.toBe(rootExecutionId);

		const waited = applyOrganizationAction(runDir, {
			name: "wait",
			execution_id: childExecutionId,
		}, T4);
		expect(waited.result).toEqual({
			status: "completed",
			termination: "first_wait",
			execution_id: childExecutionId,
			delegation_count: 2,
		});

		const artifact = readInitialOrganization(runDir);
		expect(artifact).toMatchObject({
			status: "completed",
			termination: "first_wait",
			assessment: { organization_valid: true, policy_violations: [] },
			manager_claim: {
				planning_claim_id: (claimed.result as { commitment_id: string }).commitment_id,
				work: "Inspect the Issue and define the initial organization frontier",
			},
			wait: {
				execution_id: childExecutionId,
				schema_valid: true,
				invalid_collaborate_calls: 0,
				recorded_at: T4,
			},
			metrics: {
				delegate_count: 2,
				initial_worker_count: 2,
				additional_initial_workers: 1,
				root_goal_handoff_count: 1,
				new_goal_count: 1,
				ready_now_worker_count: 2,
				waiting_on_dependencies_count: 0,
			},
		});
		expect(artifact.delegations.map((entry) => ({
			sequence: entry.sequence,
			proposal_id: entry.proposal_id,
			execution_id: entry.execution_id,
			target: entry.target,
			goal_id: entry.goal_id,
			readiness: entry.readiness,
			benchmark: entry.benchmark,
		}))).toEqual([
			{
				sequence: 1,
				proposal_id: "proposal_001",
				execution_id: rootExecutionId,
				target: "root_goal",
				goal_id: "codemark-test-run",
				readiness: "ready_now",
				benchmark: { simulated: true, execution: "not_started" },
			},
			{
				sequence: 2,
				proposal_id: "proposal_002",
				execution_id: childExecutionId,
				target: "new_goal",
				goal_id: "regression-tests",
				readiness: "ready_now",
				benchmark: { simulated: true, execution: "not_started" },
			},
		]);
		expect(artifact.timestamps.completed_at).toBe(T4);

		expect(() => applyOrganizationAction(runDir, {
			name: "delegate",
			goal_id: "codemark-test-run",
			focus: "must not extend a frozen initial frontier",
		}, "2026-09-04T00:00:05.000Z")).toThrow(/unavailable after Codemark terminated with first_wait/i);
	});

	test("captures a first wait with zero Workers as a completed but invalid organization", () => {
		const { organization } = createRun();
		expect(() => transitionOrganization(organization, {
			name: "delegate",
			goal_id: organization.run_id,
			focus: "premature delegation",
		}, T1)).toThrow(/claim.*first/i);
		const unclaimed = transitionOrganization(organization, { name: "wait" }, T1);
		expect(unclaimed.organization).toMatchObject({
			status: "completed",
			termination: "first_wait",
			metrics: { initial_worker_count: 0, delegate_count: 0 },
			assessment: {
				organization_valid: false,
				policy_violations: ["manager_claim_missing", "delegation_missing"],
			},
		});

		const claimed = transitionOrganization(organization, {
			name: "claim",
			work: "plan the work",
		}, T1).organization;
		const undelegated = transitionOrganization(claimed, { name: "wait" }, T2);
		expect(undelegated.organization.assessment).toEqual({
			organization_valid: false,
			policy_violations: ["delegation_missing"],
		});
		const unknownTarget = transitionOrganization(claimed, {
			name: "wait",
			execution_id: "exec_000000000000000000000000",
		}, T2);
		expect(unknownTarget.organization).toMatchObject({
			status: "completed",
			metrics: { initial_worker_count: 0 },
			assessment: {
				organization_valid: false,
				policy_violations: ["delegation_missing", "wait_target_unknown"],
			},
		});
	});

	test("delegate requires exactly one of goal_id or new_goal", () => {
		const { organization } = createRun();
		const claimed = transitionOrganization(organization, {
			name: "claim",
			work: "plan the work",
		}, T1).organization;

		expect(() => transitionOrganization(claimed, {
			name: "delegate",
			focus: "missing target",
		}, T2)).toThrow(/exactly one of goal_id or new_goal/i);
		expect(() => transitionOrganization(claimed, {
			name: "delegate",
			goal_id: claimed.run_id,
			new_goal: { goal_id: "ambiguous", objective: "must not be created" },
			focus: "ambiguous target",
		}, T2)).toThrow(/exactly one of goal_id or new_goal/i);
		expect(claimed.goals).toEqual([]);
		expect(claimed.delegations).toEqual([]);
	});

	test("validates Goal dependencies and preserves a DAG", () => {
		const { organization } = createRun();
		let state = transitionOrganization(organization, {
			name: "claim",
			work: "plan dependency-aware work",
		}, T1).organization;

		expect(() => transitionOrganization(state, {
			name: "delegate",
			new_goal: {
				goal_id: "consumer",
				objective: "consume a missing outcome",
				dependencies: ["missing"],
			},
			focus: "must reject an unknown dependency",
		}, T2)).toThrow(/unknown goal dependency: missing/i);
		expect(() => transitionOrganization(state, {
			name: "delegate",
			new_goal: {
				goal_id: "self-cycle",
				objective: "invalid cyclic outcome",
				dependencies: ["self-cycle"],
			},
			focus: "must reject a cycle",
		}, T2)).toThrow(/cannot depend on itself|cycle/i);

		const producer = transitionOrganization(state, {
			name: "delegate",
			new_goal: { goal_id: "producer", objective: "produce the contract" },
			focus: "define the contract",
		}, T2);
		state = producer.organization;
		const dependent = transitionOrganization(state, {
			name: "delegate",
			new_goal: {
				goal_id: "consumer",
				objective: "verify the contract consumer",
				dependencies: ["producer", "producer"],
			},
			focus: "prepare dependent verification",
		}, T3);
		expect(dependent.result).toEqual({
			goal_id: "consumer",
			status: "waiting",
			execution_id: null,
		});
		state = dependent.organization;

		expect(state.goals).toMatchObject([
			{ sequence: 1, goal_id: "producer", dependencies: [] },
			{ sequence: 2, goal_id: "consumer", dependencies: ["producer"] },
		]);
		expect(state.delegations).toMatchObject([
			{ sequence: 1, proposal_id: "proposal_001", goal_id: "producer", readiness: "ready_now" },
			{
				sequence: 2,
				proposal_id: "proposal_002",
				execution_id: null,
				goal_id: "consumer",
				readiness: "waiting_on_dependencies",
			},
		]);
		expect(state.metrics).toMatchObject({
			delegate_count: 2,
			initial_worker_count: 1,
			additional_initial_workers: 0,
			ready_now_worker_count: 1,
			waiting_on_dependencies_count: 1,
		});
	});

	test("mirrors legal progress and inspect results without writing canonical Receipts", () => {
		const { runDir } = createRun();
		const claimed = claim(runDir).result as { commitment_id: string };
		const progress = applyOrganizationAction(runDir, {
			name: "report",
			status: "progress",
			summary: "Mapped the parser boundary",
			effects: [{ file: "src/parser.ts" }],
			remaining: ["delegate independent regression coverage"],
		}, T2);
		const receiptId = (progress.result as { receipt_id: string }).receipt_id;
		expect(progress.result).toEqual({ receipt_id: receiptId, status: "progress" });
		expect(receiptId).toMatch(/^r_[0-9a-f]{64}$/);

		const commitment = applyOrganizationAction(runDir, {
			name: "inspect",
			commitment_id: claimed.commitment_id,
		}, T2).result as any;
		expect(commitment.commitment).toMatchObject({
			schema_version: 1,
			id: claimed.commitment_id,
			seq: 1,
			task_id: "codemark-test-run",
			goal_id: "codemark-test-run",
			worker_execution_id: expect.stringMatching(/^exec_[0-9a-f]{24}$/),
			claim_revision: 1,
			parent_commitment_id: null,
		});
		expect(commitment.receipts).toHaveLength(1);
		expect(commitment.receipts[0]).toMatchObject({
			id: receiptId,
			status: "progress",
			summary: "Mapped the parser boundary",
		});
		expect(applyOrganizationAction(runDir, {
			name: "inspect",
			receipt_id: receiptId,
		}, T2).result).toEqual({
			commitment: commitment.commitment,
			receipt: commitment.receipts[0],
		});

		expect(() => applyOrganizationAction(runDir, {
			name: "report",
			status: "completed",
			summary: "must not masquerade as implementation completion",
		}, T2)).toThrow(/terminal Root Receipt requires at least one Child Worker Commitment/i);

		expect(fs.readdirSync(runDir).sort()).toEqual(["frontier.json"]);
		expect(readInitialOrganization(runDir)).toMatchObject({
			status: "running",
			termination: null,
			manager_progress: [{ planning_receipt_id: receiptId }],
		});
		});

	test("keeps Goal sequence independent from Commitment and Receipt semantic sequence", () => {
		const { organization } = createRun();
		const claimed = transitionOrganization(organization, {
			name: "claim",
			work: "organize the implementation work",
		}, T1);
		const commitmentId = (claimed.result as { commitment_id: string }).commitment_id;
		const delegated = transitionOrganization(claimed.organization, {
			name: "delegate",
			new_goal: {
				goal_id: "regression-coverage",
				objective: "Design focused regression coverage",
			},
			focus: "identify the smallest independent regression suite",
		}, T2);
		expect(delegated.organization.goals).toEqual([{
			sequence: 1,
			goal_id: "regression-coverage",
			objective: "Design focused regression coverage",
			dependencies: [],
			created_at: T2,
		}]);

		const progress = transitionOrganization(delegated.organization, {
			name: "report",
			status: "progress",
			summary: "Initial organization is ready",
			remaining: ["wait for the delegated work"],
		}, T3);
		const receiptId = (progress.result as { receipt_id: string }).receipt_id;
		const inspected = transitionOrganization(progress.organization, {
			name: "inspect",
			commitment_id: commitmentId,
		}, T4).result as any;

		expect(inspected.commitment).toMatchObject({ id: commitmentId, seq: 1 });
		expect(inspected.receipts).toEqual([{
			id: receiptId,
			schema_version: 1,
			seq: 2,
			task_id: "codemark-test-run",
			goal_id: "codemark-test-run",
			commitment_id: commitmentId,
			status: "progress",
			summary: "Initial organization is ready",
			effects: [],
			remaining: ["wait for the delegated work"],
		}]);
	});

	test("mirrors a legal pre-claim blocked report without allowing a later claim", () => {
		const { runDir } = createRun();
		const blocked = applyOrganizationAction(runDir, {
			name: "report",
			status: "blocked",
			summary: "Issue lacks the required repository state",
			remaining: ["provide the missing branch"],
		}, T1);
		expect(blocked.result).toMatchObject({
			schema_version: 1,
			task_id: "codemark-test-run",
			goal_id: "codemark-test-run",
			execution_id: expect.stringMatching(/^exec_[0-9a-f]{24}$/),
			summary: "Issue lacks the required repository state",
			remaining: ["provide the missing branch"],
		});
		expect(() => applyOrganizationAction(runDir, {
			name: "claim",
			work: "must not claim after a blocker",
		}, T2)).toThrow(/reported a blocker cannot claim/i);
	});

	test("attaches exact usage totals without changing the recorded frontier", () => {
		const { runDir } = createRun();
		claim(runDir);
		applyOrganizationAction(runDir, {
			name: "delegate",
			goal_id: "codemark-test-run",
			focus: "inspect the failure",
		}, T2);
		applyOrganizationAction(runDir, { name: "wait" }, T3);

		const usage = {
			calls: 3,
			input: 101,
			output: 29,
			cache_read: 71,
			cache_write: 7,
			reasoning: 13,
			total_tokens: 221,
			cost: {
				input: 0.1,
				output: 0.2,
				cache_read: 0.03,
				cache_write: 0.04,
				total: 0.37,
			},
		};
		const attached = attachOrganizationUsage(runDir, { total: usage }, T4);
		expect(attached.usage).toEqual(usage);
		expect(attached).toMatchObject({
			status: "completed",
			termination: "first_wait",
			metrics: { delegate_count: 1, initial_worker_count: 1 },
		});
		expect(readInitialOrganization(runDir).usage).toEqual(usage);

		expect(() => attachOrganizationUsage(runDir, {
			...usage,
			total_tokens: -1,
		}, T4)).toThrow(/usage.total_tokens.*non-negative/i);
		expect(readInitialOrganization(runDir).usage).toEqual(usage);
	});

	test("artifact proposal ids stay distinct from simulated Worker execution ids", () => {
		const { runDir } = createRun();
		claim(runDir);
		const proposal = applyOrganizationAction(runDir, {
			name: "delegate",
			goal_id: "codemark-test-run",
			focus: "record only",
		}, T2).organization.delegations[0];
		expect(proposal.proposal_id).toBe("proposal_001");
		expect(proposal.execution_id).toMatch(/^exec_[0-9a-f]{24}$/);
		expect(proposal.benchmark).toEqual({ simulated: true, execution: "not_started" });
		expect(proposal.resume_commitment_id).toBeNull();
		expect(() => applyOrganizationAction(runDir, {
			name: "delegate",
			goal_id: "codemark-test-run",
			focus: "must not resume runtime state",
			resume_commitment_id: "c_live",
		}, T3)).toThrow(/unknown commitment: c_live/i);
	});

	test("finalizes non-wait exits with explicit incomplete or failed states", () => {
		for (const [termination, status] of [
			["manager_exit", "incomplete"],
			["timeout", "incomplete"],
			["output_truncated", "incomplete"],
			["provider_failure", "failed"],
			["interrupted", "interrupted"],
		] as const) {
			const { runDir } = createRun();
			const finalized = finalizeOrganization(runDir, {
				termination,
				diagnostic: `${termination} diagnostic`,
				now: T2,
			});
			expect(finalized).toMatchObject({
				status,
				termination,
				diagnostic: `${termination} diagnostic`,
				timestamps: { completed_at: T2 },
			});
		}

		const { runDir } = createRun();
		claim(runDir);
		applyOrganizationAction(runDir, {
			name: "delegate",
			goal_id: "codemark-test-run",
			focus: "record one proposal",
		}, T2);
		applyOrganizationAction(runDir, { name: "wait" }, T3);
		const unchanged = finalizeOrganization(runDir, {
			termination: "manager_exit",
			diagnostic: "must not overwrite first_wait",
			now: T4,
		});
		expect(unchanged).toMatchObject({
			status: "completed",
			termination: "first_wait",
			diagnostic: null,
			timestamps: { completed_at: T3 },
		});
		const forced = finalizeOrganization(runDir, {
			termination: "timeout",
			diagnostic: "wait landed after the timeout cutoff",
			now: T4,
			force: true,
		});
		expect(forced).toMatchObject({
			status: "incomplete",
			termination: "timeout",
			diagnostic: "wait landed after the timeout cutoff",
			timestamps: { completed_at: T4 },
		});
	});

	test("publishes one immutable terminal artifact only after usage is attached", () => {
		const { runDir } = createRun();
		const publicArtifact = `${runDir}/initial-organization.json`;
		expect(fs.existsSync(publicArtifact)).toBe(false);
		expect(() => publishInitialOrganization(runDir)).toThrow(/non-terminal/i);

		finalizeOrganization(runDir, {
			termination: "manager_exit",
			diagnostic: "Manager exited before wait",
			now: T2,
		});
		expect(fs.existsSync(publicArtifact)).toBe(false);
		expect(() => publishInitialOrganization(runDir)).toThrow(/without usage/i);

		const usage = {
			calls: 0,
			input: 0,
			output: 0,
			cache_read: 0,
			cache_write: 0,
			reasoning: 0,
			total_tokens: 0,
			cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 },
		};
		attachOrganizationUsage(runDir, usage, T3);
		const published = publishInitialOrganization(runDir);
		expect(fs.existsSync(publicArtifact)).toBe(true);
		expect(JSON.parse(fs.readFileSync(publicArtifact, "utf8"))).toEqual(published);
		expect(published).toMatchObject({
			status: "incomplete",
			termination: "manager_exit",
			usage,
		});
		expect(fs.existsSync(`${runDir}/frontier.json`)).toBe(false);
		expect(() => publishInitialOrganization(runDir)).toThrow(/already published|frontier does not exist/i);
		expect(() => attachOrganizationUsage(runDir, usage, T4)).toThrow(/frontier does not exist/i);
		expect(JSON.parse(fs.readFileSync(publicArtifact, "utf8"))).toEqual(published);
	});
});
