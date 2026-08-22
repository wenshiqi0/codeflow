import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applySemanticHandoffIndexCard,
	listHandoffIndex,
	recallHandoff,
	writeDeterministicHandoffIndexCard,
} from "../../runtime/lib/collaboration-index";
import { defineGoal } from "../../runtime/lib/goals";
import { finishHandoff, openHandoff } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";

const REPO = path.resolve(import.meta.dir, "../..");
const CODE_AGENT = path.join(REPO, "runtime", "bin", "code-agent");
let project: string;
let paths: RunPaths;
const savedGoal: string | undefined = process.env.CODEFLOW_GOAL_ID;

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-collab-index-"));
	paths = new RunPaths(path.join(project, ".codeflow", "runs", "code"), "run-collab-index");
	process.env.CODEFLOW_RUN_ID = paths.runId;
	process.env.CODEFLOW_RUNS_DIR = paths.code;
	delete process.env.CODEFLOW_GOAL_ID;
});

afterEach(() => {
	if (savedGoal === undefined) delete process.env.CODEFLOW_GOAL_ID;
	else process.env.CODEFLOW_GOAL_ID = savedGoal;
	fs.rmSync(project, { recursive: true, force: true });
});

function cli(group: string, args: string[]) {
	return Bun.spawnSync(["bash", CODE_AGENT, group, ...args], {
		cwd: project,
		env: {
			...process.env,
			CODEFLOW_RUN_ID: paths.runId,
			CODEFLOW_RUNS_DIR: paths.code,
		},
	});
}

describe("pull-based collaboration index", () => {
	test("ambient goal query is scoped without a goal argument", () => {
		defineGoal(paths, { id: "movement-r1", goal: "Deterministic movement" });
		const testHandoff = openHandoff(paths, {
			role: "tester",
			depth: 1,
			body: "Outcome: author focused movement test\n",
			goalId: "movement-r1",
			lane: "test",
		});
		openHandoff(paths, {
			role: "architect",
			depth: 1,
			body: "Outcome: review movement boundary\n",
		});
		process.env.CODEFLOW_GOAL_ID = "movement-r1";

		const cards = listHandoffIndex(paths);
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({
			goal_id: "movement-r1",
			handoff_id: testHandoff.handoff_id,
			role: "tester",
			lane: "test",
		});
	});

	test("cross-goal lookup and unlaned lookup are explicit", () => {
		defineGoal(paths, { id: "movement-r1", goal: "Deterministic movement" });
		defineGoal(paths, { id: "billing-r1", goal: "Deterministic billing" });
		openHandoff(paths, {
			role: "tester",
			depth: 1,
			body: "Outcome: movement test\n",
			goalId: "movement-r1",
			lane: "test",
		});
		openHandoff(paths, {
			role: "coder",
			depth: 1,
			body: "Outcome: billing fix\n",
			goalId: "billing-r1",
			lane: "code",
		});
		const unlaned = openHandoff(paths, {
			role: "architect",
			depth: 1,
			body: "Outcome: architecture review\n",
		});

		expect(listHandoffIndex(paths, { goalId: "billing-r1" })).toHaveLength(1);
		expect(listHandoffIndex(paths, { unlaned: true })).toMatchObject([
			{ handoff_id: unlaned.handoff_id },
		]);
		expect(() => listHandoffIndex(paths, {})).toThrow(/ambient CODEFLOW_GOAL_ID/);
	});

	test("filters and deterministic open/final cards work", () => {
		defineGoal(paths, { id: "movement-r1", goal: "Deterministic movement" });
		const opened = openHandoff(paths, {
			role: "tester",
			depth: 1,
			body: "Outcome: author focused movement regression\n",
			goalId: "movement-r1",
			lane: "test",
		});
		const receipt = path.join(project, "receipt.json");
		fs.writeFileSync(receipt, JSON.stringify({
			status: "PASS",
			established: ["movement failure is in bounds"],
			changed_files: ["test_movement.py"],
		}));
		finishHandoff(paths, {
			handoffId: opened.handoff_id,
			status: "PASS",
			summary: "Focused movement regression established",
			receipt,
		});
		const final = writeDeterministicHandoffIndexCard(
			paths,
			JSON.parse(fs.readFileSync(paths.statePath(opened.handoff_id), "utf8")),
			"final",
		);
		expect(final).toMatchObject({
			phase: "final",
			status: "done",
			result: "PASS",
			established: ["movement failure is in bounds"],
			changed_files: ["test_movement.py"],
			fallback: true,
		});
		expect(listHandoffIndex(paths, { goalId: "movement-r1", status: "pass" })).toHaveLength(1);
		expect(listHandoffIndex(paths, { goalId: "movement-r1", status: "blocked" })).toHaveLength(0);
		expect(listHandoffIndex(paths, { goalId: "movement-r1", query: "bounds" })).toHaveLength(1);
	});

	test("handoff landing writes deterministic cards before semantic upgrade", () => {
		defineGoal(paths, { id: "movement-r1", goal: "Deterministic movement" });
		const opened = openHandoff(paths, {
			role: "coder",
			depth: 1,
			body: "Outcome: implement movement bounds fix\n",
			goalId: "movement-r1",
			lane: "code",
		});
		const openCard = JSON.parse(
			fs.readFileSync(
				path.join(paths.collaborationIndexDir("movement-r1"), `${opened.handoff_id}.open.json`),
				"utf8",
			),
		);
		expect(openCard).toMatchObject({ phase: "open", fallback: true });

		finishHandoff(paths, {
			handoffId: opened.handoff_id,
			status: "BLOCKED",
			blockedReasons: ["CONTEXT_BUDGET_EXCEEDED"],
			summary: "movement bounds hypothesis established; split implementation",
		});
		const finalCard = JSON.parse(
			fs.readFileSync(
				path.join(paths.collaborationIndexDir("movement-r1"), `${opened.handoff_id}.final.json`),
				"utf8",
			),
		);
		expect(finalCard).toMatchObject({ phase: "final", status: "blocked", fallback: true });
	});

	test("semantic zipper output upgrades bounded fields without changing source hashes", () => {
		defineGoal(paths, { id: "movement-r1", goal: "Deterministic movement" });
		const opened = openHandoff(paths, {
			role: "coder",
			depth: 1,
			body: "Outcome: implement movement fix\n",
			goalId: "movement-r1",
			lane: "code",
		});
		const state = JSON.parse(fs.readFileSync(paths.statePath(opened.handoff_id), "utf8"));
		const base = writeDeterministicHandoffIndexCard(paths, state, "open");
		const semantic = applySemanticHandoffIndexCard(base, JSON.stringify({
			title: "Movement fix",
			digest: "Localized the defect to movement bounds and prepared the focused fix.",
			established: ["movement bounds mutation is the defect"],
			ruled_out: ["coordinate transform regression"],
		}));
		expect(semantic).toMatchObject({
			title: "Movement fix",
			fallback: false,
			generator: { kind: "zipper" },
			established: ["movement bounds mutation is the defect"],
			ruled_out: ["coordinate transform regression"],
			source: base.source,
		});
	});

	test("exact recall may cross goals and missing receipt is explicit", () => {
		defineGoal(paths, { id: "movement-r1", goal: "Deterministic movement" });
		const opened = openHandoff(paths, {
			role: "coder",
			depth: 1,
			body: "Outcome: implement movement fix\n",
			goalId: "movement-r1",
			lane: "code",
		});
		finishHandoff(paths, {
			handoffId: opened.handoff_id,
			status: "BLOCKED",
			blockedReasons: ["CONTEXT_BUDGET_EXCEEDED"],
			summary: "needs split",
		});
		const recalled = recallHandoff(paths, opened.handoff_id);
		expect(recalled.body).toContain("implement movement fix");
		expect(recalled.receipt).toBeNull();
		expect(recalled.index_card).toMatchObject({
			status: "blocked",
			blocked_reasons: ["CONTEXT_BUDGET_EXCEEDED"],
		});
	});

	test("CLI exposes goal directories and bounded handoff index", () => {
		defineGoal(paths, { id: "movement-r1", goal: "Deterministic movement" });
		const opened = openHandoff(paths, {
			role: "tester",
			depth: 1,
			body: "Outcome: author movement regression\n",
			goalId: "movement-r1",
			lane: "test",
		});
		const goals = cli("goal", ["list"]);
		expect(goals.exitCode).toBe(0);
		expect(JSON.parse(goals.stdout.toString())).toMatchObject([
			{ goal_id: "movement-r1" },
		]);

		const index = cli("handoff", ["index", "--goal-id", "movement-r1", "--limit", "5"]);
		expect(index.exitCode).toBe(0);
		expect(JSON.parse(index.stdout.toString())).toMatchObject([
			{ handoff_id: opened.handoff_id },
		]);

		const noScope = cli("handoff", ["index"]);
		expect(noScope.exitCode).toBe(1);
		expect(noScope.stderr.toString()).toContain("ambient CODEFLOW_GOAL_ID");
	});
});
