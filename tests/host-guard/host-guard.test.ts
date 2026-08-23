import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { runtimeBashViolation, runtimeWriteViolation } from "../../runtime/extensions/host-guard/policy";

const runtimeDir = path.resolve(import.meta.dir, "../../runtime");

function environment(project: string, evidence: string, runs: string): Record<string, string> {
	return {
		CODEFLOW_PROJECT_DIR: project,
		CODEFLOW_EVIDENCE_DIR: evidence,
		CODEFLOW_RUNS_DIR: runs,
		CODEFLOW_RUN_ID: "run-host-guard",
	};
}

describe("host runtime guard", () => {
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
		const receipt = path.join(runs, "run-host-guard/h000001/receipt.json");
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
});
