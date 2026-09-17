import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "../..");

function filesBelow(directory: string): string[] {
	const files: string[] = [];
	const walk = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else files.push(full);
		}
	};
	walk(directory);
	return files;
}

describe("single current architecture", () => {
	test("removed runtime subsystems and registries do not exist", () => {
		for (const relative of [
			"runtime/roles.json",
			"runtime/skills",
			"runtime/lib/admission.ts",
			"runtime/lib/roles.ts",
			"runtime/lib/facts.ts",
			"runtime/lib/collaboration-index.ts",
			"runtime/lib/workspace-state.ts",
			"runtime/extensions/codeflow-task",
			"runtime/quality/test-patch.ts",
			"runtime/cli/commitment.ts",
			"runtime/extensions/codeflow-organization/worker-launcher.ts",
			"runtime/extensions/codeflow-organization/feedback.ts",
			"runtime/lib/agent-capacity.ts",
			"references/patterns.md",
			"references/work-methods",
		]) expect(fs.existsSync(path.join(root, relative))).toBe(false);
	});

	test("active runtime has no compatibility identity or mutable-state API", () => {
		const files = filesBelow(path.join(root, "runtime")).filter((file) => /\.(ts|json|sh)$/.test(file));
		const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
		for (const residue of [
			"CODEFLOW_AGENT_ROLE",
			"CODEFLOW_AGENT_DEPTH",
			"CODEFLOW_THREAD",
			"roles.json",
			"codeflow-task",
			"facts.jsonl",
			"acceptance_context",
			"goal_lane",
			"_ungrouped",
			"_default",
			"CODEFLOW_ADMISSION_JSON",
			"coding_complexity",
			"solo_estimate",
			"outer_assessment",
		]) expect(source).not.toContain(residue);
	});

	test("the outer codeteam command retains engineering helpers and has no legacy identity", () => {
		const runtimeBin = path.join(root, "runtime", "bin");
		const launcherPath = path.join(runtimeBin, "codeteam");
		const launcher = fs.readFileSync(launcherPath, "utf8");
		const retiredLauncher = path.join(root, "runtime", "bin", ["code", "agent"].join("-"));
		expect(fs.existsSync(retiredLauncher)).toBe(false);
		expect(fs.statSync(launcherPath).mode & 0o111).not.toBe(0);
		expect(launcher).not.toContain("commitment open");
		expect(launcher).not.toContain("goal create");
		expect(launcher).not.toContain("receipt submit");
		expect(launcher).not.toContain("recall goal");
		expect(launcher).toContain("evidence");
		expect(launcher).toContain("check");
		const help = Bun.spawnSync(["codeteam", "--help"], {
			cwd: root,
			env: {
				...process.env,
				CODEFLOW_RUN_ID: "task-codeteam-test",
				PATH: `${runtimeBin}:${process.env.PATH ?? ""}`,
			},
		});
		expect(help.exitCode).toBe(0);
		expect(help.stdout.toString()).toContain("usage: codeteam <command>");
	});

	test("the Pi extension graph has no recursive launcher or feedback keepalive", () => {
		const extensions = filesBelow(path.join(root, "runtime/extensions"))
			.filter((file) => file.endsWith(".ts"));
		const source = extensions.map((file) => fs.readFileSync(file, "utf8")).join("\n");
		expect(source).not.toMatch(/from ["'][^"']*(?:worker-launcher|agent-capacity|\/feedback)["']/);
		const organization = fs.readFileSync(path.join(root, "runtime/extensions/codeflow-organization/index.ts"), "utf8");
		expect(organization).not.toMatch(/registerWorkerFeedback|delegateWorker|hasLiveWorkers|sendMessage/);
		expect(organization).toContain("validateTeamAgentStartup");
		expect(organization).toContain("process.exit(1)");
	});

	test("codeteam validates Worker arguments without rejecting its identity", () => {
		const result = Bun.spawnSync(["bash", path.join(root, "runtime/bin/codeteam"), "spawn", "task-existing"], {
			cwd: root,
			env: { ...process.env, CODEFLOW_RUN_ID: "task-existing", CODEFLOW_EXECUTION_ID: "exec-inner", CODEFLOW_TEAM_AGENT_ID: "agent-inner" },
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("spawn <task>");
		expect(result.stderr.toString()).not.toContain("outer-loop only");
	});

	test("standalone entry validates arguments before starting a nested execution", () => {
		const result = Bun.spawnSync(
			["bash", path.join(root, "runtime/bin/codeflow"), "exec", "--invalid", "nested"],
			{ cwd: root, env: { ...process.env, CODEFLOW_RUN_ID: "task-existing" } },
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("unknown exec option");
	});
});
