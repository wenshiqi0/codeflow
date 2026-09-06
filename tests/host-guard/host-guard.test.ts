import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { RunPaths } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";
import { claimTestWork } from "../runtime/helpers";
import { recordRuntimeFailure, resumeCommitment, submitReceipt } from "../../runtime/lib/commitment";
import hostGuard from "../../runtime/extensions/host-guard";
import {
	runtimeBashViolation,
	runtimeWriteViolation,
} from "../../runtime/extensions/host-guard/policy";

const runtimeDir = path.resolve(import.meta.dir, "../../runtime");

function environment(project: string, evidence: string, runs: string): Record<string, string> {
	return {
		CODEFLOW_PROJECT_DIR: project,
		CODEFLOW_EVIDENCE_DIR: evidence,
		CODEFLOW_RUNS_DIR: runs,
		CODEFLOW_RUN_ID: "run-host-guard",
	};
}

function withGuard(
	overrides: Record<string, string | undefined>,
	check: (call: (event: unknown) => unknown, entries: unknown[]) => void,
): void {
	const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
	const setEnvironment = (values: Record<string, string | undefined>) => {
		for (const [key, value] of Object.entries(values)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	try {
		setEnvironment(overrides);
		const handlers: Record<string, (event: unknown) => unknown> = {};
		const entries: unknown[] = [];
		hostGuard({
			on: (kind: string, handler: (event: unknown) => unknown) => { handlers[kind] = handler; },
			appendEntry: (type: string, payload: unknown) => { entries.push({ type, payload }); },
		} as never);
		check(handlers.tool_call, entries);
	} finally { setEnvironment(saved); }
}

describe("host runtime guard", () => {
	test.each([
		"pi -p nested",
		"/usr/local/bin/pi --mode json -p nested",
		"env -u CODEFLOW_RUN_ID -u CODEFLOW_EXECUTION_ID pi -p nested",
		"env --unset=CODEFLOW_RUN_ID -- /usr/local/bin/pi -p nested",
		"env -i PATH=/usr/bin /usr/local/bin/pi -p nested",
		"unset CODEFLOW_RUN_ID; codeteam spawn task-existing --focus nested",
		"CODEFLOW_RUN_ID= codeflow exec nested",
		"codeflow resume task-existing",
		"codeteam task nested",
		"codeteam start nested",
		"codeteam goal task-existing different-outcome",
		"codeteam followup task-existing agent-one nested",
		"codeteam resume task-existing agent-one",
		"codeteam finish task-existing completed",
		"codeteam stop task-existing",
		"command codeteam spawn task-existing",
		"nohup env -u CODEFLOW_RUN_ID codeteam spawn task-existing &",
		"timeout 10s /usr/local/bin/pi -p nested",
		"bash -c 'env -u CODEFLOW_RUN_ID codeteam spawn task-existing'",
		"bash /opt/codeflow/runtime/bin/codeflow exec nested",
		"bun runtime/cli/run.ts exec nested",
		"node --import tsx ./runtime/cli/team.ts spawn task-existing",
		"bun /opt/codeflow/runtime/cli/../cli/run.ts resume task-existing",
		"bun /opt/codeflow/runtime/cli/outer.ts stop task-existing",
		"bun /opt/codeflow/runtime/lib/team.ts",
		"bun /opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js -p nested",
		"npx @earendil-works/pi-coding-agent -p nested",
		"codemark task-existing",
		'codeteam evidence run --command "codeteam spawn task-existing"',
		'codeteam evidence run --command "pi -p nested"',
	])("does not impose an executor-specific launch prohibition: %s", (command) => {
		expect(runtimeBashViolation(command, { CODEFLOW_COMMITMENT_ID: "claimed" })).toBeNull();
	});
	test.each(["start", "goal", "spawn", "followup", "resume", "status", "inspect", "watch", "sub", "usage", "finish", "stop"])("allows the public absolute codeteam %s entry", (verb) => {
		expect(runtimeBashViolation(`${runtimeDir}/bin/codeteam ${verb} task-existing`)).toBeNull();
	});
	test("public codeteam commands cannot redirect output into Runtime files", () => {
		expect(runtimeBashViolation(`${runtimeDir}/bin/codeteam status task-existing > ${runtimeDir}/config.json`)).toContain("read-only");
	});

	test.each([
		"codeteam evidence run --label regression --command 'bun test tests/parser.test.ts'",
		"codeteam evidence batch cases.json",
		"codeteam evidence log regression",
		"codeteam check source src/parser.ts",
		`${runtimeDir}/bin/codeteam check source src/parser.ts`,
		`${runtimeDir}/bin/codeteam evidence log regression`,
		"codeteam status task-existing",
		"codeflow inspect task-existing",
		"rg pi README.md",
		"python tests/runtests.py",
		"bun test",
	])("preserves engineering and inspection commands: %s", (command) => {
		expect(runtimeBashViolation(command)).toBeNull();
	});

	test.each(["root", "worker", "team"])("does not gate %s Agent tools on missing or stale Claim state", (identity) => {
		const project = path.join(os.tmpdir(), "codeflow-product");
		withGuard({
			...environment(project, "/tmp/evidence", "/tmp/runs"),
			CODEFLOW_PROCESS_KIND: identity === "team" ? undefined : identity,
			CODEFLOW_TEAM_AGENT_ID: identity === "team" ? "agent-one" : undefined,
			CODEFLOW_COMMITMENT_ID: undefined,
		}, (call, entries) => {
			for (const commitmentId of [undefined, "c_claimed", `c_${"a".repeat(64)}`]) {
				if (commitmentId === undefined) delete process.env.CODEFLOW_COMMITMENT_ID;
				else process.env.CODEFLOW_COMMITMENT_ID = commitmentId;
				for (const event of [
					{ toolName: "read", input: { path: path.join(project, "src/app.ts") } },
					{ toolName: "collaborate", input: { action: { name: "claim" } } },
					...[
						"ls ../ && cat ../issue.json",
						`cd ${project} && rg TODO src | head -20`,
						"grep -n Food src/app.ts | head -20",
						"ls src\ncat src/app.ts",
						`echo proof > ${project}/proof.txt`,
						"python tests/runtests.py",
						"bun test",
						"codeteam spawn task-existing 'Work'",
						`${runtimeDir}/bin/codeteam spawn task-existing 'Work'`,
					].map((command) => ({ toolName: "bash", input: { command } })),
					{ toolName: "edit", input: { path: path.join(project, "src/app.ts") } },
					{ toolName: "write", input: { path: path.join(project, "src/app.ts") } },
				]) expect(call(event)).toBeUndefined();
			}
			expect(entries).toHaveLength(0);
		});
	});

	test("keeps project tool access independent of the Commitment lifecycle", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-open-claim-"));
		try {
			const paths = new RunPaths(path.join(dir, "runs"), "task-guard");
			createTask(paths, "Verify Claim-independent tool access");
			withGuard({
				CODEFLOW_PROCESS_KIND: "worker",
				CODEFLOW_RUN_ID: paths.runId,
				CODEFLOW_RUNS_DIR: paths.code,
				CODEFLOW_COMMITMENT_ID: undefined,
			}, (call, entries) => {
				const edit = () => call({ toolName: "edit", input: { path: path.join(dir, "app.ts") } });
				expect(edit()).toBeUndefined();
				const first = claimTestWork(paths, { goalId: paths.runId, work: "First work" });
				process.env.CODEFLOW_COMMITMENT_ID = first.id;
				expect(edit()).toBeUndefined();
				submitReceipt(paths, { commitmentId: first.id, status: "completed", summary: "First work verified" });
				expect(edit()).toBeUndefined();
				const next = claimTestWork(paths, { goalId: paths.runId, work: "Follow-on work" });
				process.env.CODEFLOW_COMMITMENT_ID = next.id;
				expect(edit()).toBeUndefined();
				recordRuntimeFailure(paths, next.id, ["USER_CANCELLED"], "Interrupted");
				resumeCommitment(paths, next.id, "exec-resumed", process.pid);
				expect(edit()).toBeUndefined();
				submitReceipt(paths, { commitmentId: next.id, status: "blocked", summary: "Needs clarification", remaining: ["Resolve the ambiguity"] });
				expect(edit()).toBeUndefined();
				expect(entries).toHaveLength(0);
			});
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	test("blocks writes inside the Codeflow runtime", () => {
		expect(runtimeWriteViolation(path.join(runtimeDir, "lib/paths.ts"))).toContain(
			"read-only during a run",
		);
		expect(runtimeWriteViolation(path.join(runtimeDir, "../SKILL.md"))).toBeNull();
		expect(runtimeWriteViolation(path.join(os.tmpdir(), "codeflow-product/src/app.ts"))).toBeNull();
	});

	test("allows project and evidence workspaces, including a nested benchmark workspace", () => {
		const project = path.join(os.tmpdir(), "codeflow-host-guard-product");
		const evidence = path.join(os.tmpdir(), "codeflow-host-guard-evidence");
		const runs = path.join(os.tmpdir(), "codeflow-host-guard-runs");
		const env = environment(project, evidence, runs);
		const nested = path.join(project, ".codeflow/benchmark/case/workspace/src/app.ts");
		expect(runtimeWriteViolation(nested, env)).toBeNull();
		expect(runtimeWriteViolation(path.join(evidence, "goal/commands/proof.json"), env)).toBeNull();
		expect(runtimeBashViolation(`echo proof > ${nested}`, env)).toBeNull();
	});

	test("blocks run metadata even when it is nested in the project workspace", () => {
		const project = path.join(os.tmpdir(), "codeflow-host-guard-product");
		const evidence = path.join(os.tmpdir(), "codeflow-host-guard-evidence");
		const runs = path.join(project, ".codeflow/runs/code");
		const env = environment(project, evidence, runs);
		const state = path.join(runs, "run-host-guard/task.json");
		const receipt = path.join(runs, "run-host-guard/commitments/c000001/receipts/r000001.json");
		expect(runtimeWriteViolation(state, env)).toContain("read-only during a run");
		expect(runtimeWriteViolation(receipt, env)).toContain("read-only during a run");
		expect(runtimeBashViolation(`echo '{}' > ${state}`, env)).toContain("read-only during a run");
	});

	test("explicit workspaces do not override exact runtime protection", () => {
		const env = environment(
			path.dirname(runtimeDir),
			path.dirname(runtimeDir),
			path.join(os.tmpdir(), "codeflow-host-guard-runs"),
		);
		expect(runtimeWriteViolation(path.join(runtimeDir, "lib/paths.ts"), env)).toContain(
			"read-only during a run",
		);
	});

	test("allows runtime inspection but blocks mutation commands", () => {
		expect(runtimeBashViolation(`sed -i s/x/y/ ${runtimeDir}/lib/paths.ts`)).toContain(
			"read-only during a run",
		);
		expect(runtimeBashViolation("cat $PI_CODING_AGENT_DIR/AGENTS.md")).toBeNull();
		expect(runtimeBashViolation("rg graph src")).toBeNull();
		expect(runtimeBashViolation("ls $PI_CODING_AGENT_DIR/../references")).toBeNull();
		expect(runtimeBashViolation("git -C $PI_CODING_AGENT_DIR status --short")).toBeNull();
		expect(runtimeBashViolation("git -C $PI_CODING_AGENT_DIR checkout -- AGENTS.md")).toContain(
			"read-only during a run",
		);
		expect(runtimeBashViolation("find $PI_CODING_AGENT_DIR -name '*.ts'")).toBeNull();
		expect(runtimeBashViolation("find $PI_CODING_AGENT_DIR -delete")).toContain(
			"read-only during a run",
		);
		expect(runtimeBashViolation("cat > $PI_CODING_AGENT_DIR/lib/x")).toContain(
			"read-only during a run",
		);
	});

	test("blocks indirect root filesystem scans but allows scoped find", () => {
		expect(
			runtimeBashViolation(
				'ls ./codeflow/agents 2>/dev/null || find / -name "architect.md" -path "*agents*"',
			),
		).toContain("must not scan the host filesystem root");
		expect(runtimeBashViolation("find '/' -name architect.md")).toContain(
			"must not scan the host filesystem root",
		);
		expect(runtimeBashViolation("find /tmp -name architect.md")).toBeNull();
		expect(runtimeBashViolation("find . -name architect.md")).toBeNull();
	});

	test("extension terminates the role on a blocked tool call", async () => {
		const mod = await import("../../runtime/extensions/host-guard/index.ts");
		const handlers: Record<string, (event: unknown) => unknown> = {};
		const entries: unknown[] = [];
		const pi = {
			on: (kind: string, handler: (event: unknown) => unknown) => {
				handlers[kind] = handler;
			},
			appendEntry: (type: string, payload: unknown) => {
				entries.push({ type, payload });
			},
		};
		mod.default(pi as never);
		const result = handlers.tool_call({
			toolName: "write",
			input: { path: path.join(runtimeDir, "lib/paths.ts") },
		}) as { block: boolean; terminate: boolean; reason: string };
		expect(result).toMatchObject({
			block: true,
			terminate: true,
			reason: expect.stringContaining("read-only during a run"),
		});
		expect(entries).toHaveLength(1);
	});

	test("extension allows direct runtime reads", async () => {
		const mod = await import("../../runtime/extensions/host-guard/index.ts");
		const handlers: Record<string, (event: unknown) => unknown> = {};
		const entries: unknown[] = [];
		const pi = {
			on: (kind: string, handler: (event: unknown) => unknown) => {
				handlers[kind] = handler;
			},
			appendEntry: (type: string, payload: unknown) => entries.push({ type, payload }),
		};
		mod.default(pi as never);
		const result = handlers.tool_call({
			toolName: "read",
			input: { path: path.join(runtimeDir, "AGENTS.md") },
		});
		expect(result).toBeUndefined();
		expect(entries).toHaveLength(0);
	});

	test("extension still terminates unclaimed work that violates Runtime protections", () => {
		const runs = path.join(os.tmpdir(), "codeflow-host-guard-runs");
		const state = path.join(runs, "run-host-guard/task.json");
		withGuard({
			...environment("/tmp/project", "/tmp/evidence", runs),
			CODEFLOW_PROCESS_KIND: "worker",
			CODEFLOW_COMMITMENT_ID: undefined,
		}, (call, entries) => {
			for (const event of [
				{ toolName: "write", input: { path: path.join(runtimeDir, "lib/paths.ts") } },
				{ toolName: "edit", input: { path: state } },
				{ toolName: "bash", input: { command: `echo '{}' > ${state}` } },
				{ toolName: "bash", input: { command: `${runtimeDir}/bin/codeteam status task-existing > ${runtimeDir}/config.json` } },
			]) expect(call(event)).toMatchObject({ block: true, terminate: true, reason: expect.stringContaining("read-only during a run") });
			expect(call({ toolName: "bash", input: { command: "find / -name app.ts" } }))
				.toMatchObject({ block: true, terminate: true, reason: expect.stringContaining("must not scan the host filesystem root") });
			expect(entries).toHaveLength(5);
			for (const entry of entries) expect(entry).toMatchObject({ type: "codeflow:host_runtime_violation" });
		});
	});
});
