import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseEnv, cleanupTmpDirs, makeTmpDir, REPO, runCodemark } from "./helpers";

afterEach(cleanupTmpDirs);

const FAKE_PI = path.join(REPO, "tests", "fixtures", "codemark", "fake-pi.ts");
const REAL_PI = path.join(REPO, "tests", "fixtures", "codemark", "real-pi.ts");

function readJson(file: string): any {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function filesBelow(root: string, prefix = ""): string[] {
	if (!fs.existsSync(root)) return [];
	return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const relative = path.join(prefix, entry.name);
		return entry.isDirectory()
			? filesBelow(path.join(root, entry.name), relative)
			: [relative];
	}).sort();
}

function fakeEnvironment(extra: Record<string, string> = {}): Record<string, string> {
	return {
		...baseEnv(),
		CODEFLOW_HOME: makeTmpDir("codemark-fake-home-"),
		CODEFLOW_PI_CLI: FAKE_PI,
		...extra,
	};
}

describe("Codemark process boundary", () => {
	test("never replaces an existing dangling output symlink", () => {
		const repository = makeTmpDir("codemark-dangling-output-repository-");
		const outputParent = makeTmpDir("codemark-dangling-output-parent-");
		const outDir = path.join(outputParent, "run");
		const missingTarget = path.join(outputParent, "missing-target");
		fs.symlinkSync(missingTarget, outDir);

		const result = runCodemark(["--out", outDir, "Do not replace this target"], {
			cwd: repository,
			env: fakeEnvironment(),
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/output directory already exists/i);
		expect(fs.lstatSync(outDir).isSymbolicLink()).toBe(true);
		expect(fs.existsSync(missingTarget)).toBe(false);
	});

	test("standalone command runs one fake Agent and writes the complete measured frontier", () => {
		const repository = makeTmpDir("codemark-fake-repository-");
		const outDir = path.join(makeTmpDir("codemark-fake-output-"), "run");
		const result = runCodemark([
			"--out", outDir,
			"--timeout", "10",
			"Split parser diagnosis from regression coverage",
		], { cwd: repository, env: fakeEnvironment(), timeoutMs: 15_000 });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("codemark run_id=");

		const summary = JSON.parse(result.stdout.trim());
		const request = readJson(path.join(outDir, "request.json"));
		const canonicalRepository = fs.realpathSync(repository);
		const artifact = readJson(path.join(outDir, "initial-organization.json"));
		const usage = readJson(path.join(outDir, "usage.json"));
		expect(summary).toMatchObject({
			run_id: request.run_id,
			status: "completed",
			termination: "first_turn_end",
			artifact: path.join(outDir, "initial-organization.json"),
			metrics: {
				delegate_count: 3,
				initial_worker_count: 2,
				additional_initial_workers: 1,
				ready_now_worker_count: 2,
				waiting_on_dependencies_count: 1,
			},
		});
		expect(request).toMatchObject({
			issue: "Split parser diagnosis from regression coverage",
			repository: canonicalRepository,
			limits: { timeout_seconds: 10 },
		});
		expect(request.manager.prompts).toEqual(["references/agent.md"]);
		expect(artifact).toMatchObject({
			run_id: request.run_id,
			status: "completed",
			termination: "first_turn_end",
			metrics: {
				delegate_count: 3,
				initial_worker_count: 2,
				additional_initial_workers: 1,
				ready_now_worker_count: 2,
				waiting_on_dependencies_count: 1,
				root_goal_handoff_count: 1,
				new_goal_count: 2,
			},
		});
		expect(artifact.manager.prompt_paths).toEqual(["references/agent.md"]);
		expect(artifact.delegations).toHaveLength(3);
		expect(artifact.delegations[0]).toMatchObject({
			sequence: 1,
			proposal_id: "proposal_001",
			target: "root_goal",
			readiness: "ready_now",
			benchmark: { simulated: true, execution: "not_started" },
		});
		expect(artifact.delegations[0].execution_id).toMatch(/^exec_[0-9a-f]{24}$/);
		expect(artifact.delegations[1]).toMatchObject({
			sequence: 2,
			proposal_id: "proposal_002",
			target: "new_goal",
			readiness: "ready_now",
		});
		expect(artifact.delegations[1].execution_id).toMatch(/^exec_[0-9a-f]{24}$/);
		expect(artifact.delegations[2]).toMatchObject({
			sequence: 3,
			proposal_id: "proposal_003",
			target: "new_goal",
			readiness: "waiting_on_dependencies",
			execution_id: null,
		});

		const expectedUsage = {
			calls: 1,
			input: 100,
			output: 20,
			cache_read: 30,
			cache_write: 4,
			reasoning: 5,
			total_tokens: 159,
			cost: { input: 0.1, output: 0.2, cache_read: 0.03, cache_write: 0.04, total: 0.37 },
		};
		expect(artifact.usage).toEqual(expectedUsage);
		expect(usage.total).toEqual(expectedUsage);
		expect(usage.records).toHaveLength(1);
		expect(usage.records[0]).toMatchObject({
			run_id: request.run_id,
			process_kind: "manager",
			provider: "fake-provider",
			model: "fake-manager-response",
		});

		expect(fs.existsSync(path.join(repository, ".codeflow"))).toBe(false);
		expect(fs.existsSync(path.join(outDir, "commitments"))).toBe(false);
		expect(fs.existsSync(path.join(outDir, "receipts"))).toBe(false);
		expect(fs.readdirSync(outDir).sort()).toEqual([
			"initial-organization.json",
			"request.json",
			"usage.json",
		]);
	});

	test("the real Pi loop allows tool feedback before its first natural turn end and persists no session", () => {
		const repository = makeTmpDir("codemark-real-pi-repository-");
		const outDir = path.join(makeTmpDir("codemark-real-pi-output-"), "run");
		const sessions = path.join(REPO, "runtime", "sessions");
		const sessionsBefore = filesBelow(sessions);
		const result = runCodemark([
			"--model", "codemark-offline/manager",
			"--out", outDir,
			"--timeout", "10",
			"Exercise the real Pi termination boundary",
		], {
			cwd: repository,
			env: fakeEnvironment({ CODEFLOW_PI_CLI: REAL_PI }),
			timeoutMs: 15_000,
		});

		expect(result.exitCode).toBe(0);
		const artifact = readJson(path.join(outDir, "initial-organization.json"));
		expect(artifact).toMatchObject({
			status: "completed",
			termination: "first_turn_end",
			metrics: { delegate_count: 1, initial_worker_count: 1 },
			usage: { calls: 2 },
		});
		expect(artifact.usage.total_tokens).toBeGreaterThan(0);
		expect(filesBelow(sessions)).toEqual(sessionsBefore);
		expect(fs.existsSync(path.join(repository, ".codeflow"))).toBe(false);
	});

	for (const scenario of [
		{ mode: "zero-workers", workers: 0, calls: 1, violations: ["manager_claim_missing"] },
		{ mode: "leaf", workers: 0, calls: 2, violations: [] },
		{ mode: "multi-step", workers: 2, calls: 3, violations: [] },
	]) {
		test(`real offline Pi freezes the natural initial organization: ${scenario.mode}`, () => {
			const repository = makeTmpDir("codemark-real-frontier-repository-");
			const outDir = path.join(makeTmpDir("codemark-real-frontier-output-"), "run");
			const result = runCodemark(["--model", "codemark-offline/manager", "--out", outDir, "--timeout", "10", "Organize this issue"], {
				cwd: repository,
				env: fakeEnvironment({ CODEFLOW_PI_CLI: REAL_PI, CODEMARK_OFFLINE_SCENARIO: scenario.mode }),
				timeoutMs: 15_000,
			});
			expect(result.exitCode).toBe(0);
			const artifact = readJson(path.join(outDir, "initial-organization.json"));
			expect(artifact).toMatchObject({
				status: "completed", termination: "first_turn_end",
				metrics: { delegate_count: scenario.workers, initial_worker_count: scenario.workers },
				assessment: { organization_valid: scenario.violations.length === 0, policy_violations: scenario.violations },
				usage: { calls: scenario.calls },
			});
			if (scenario.mode === "leaf") {
				expect(artifact.manager_progress).toMatchObject([{
					status: "completed", benchmark: { simulated: true, canonical_receipt_written: false },
				}]);
				expect(artifact.delegations).toEqual([]);
				expect(fs.readdirSync(repository)).toEqual([]);
				expect(fs.readdirSync(outDir).sort()).toEqual(["initial-organization.json", "request.json", "usage.json"]);
			}
		});
	}

	test("the real Pi Agent cannot observe private harness state through read or project output", () => {
		const repository = makeTmpDir("codemark-identity-repository-");
		const codeflowHome = makeTmpDir("codemark-identity-home-");
		fs.writeFileSync(path.join(repository, "inside.txt"), "INSIDE_REPOSITORY_CANARY", "utf8");
		fs.writeFileSync(
			path.join(codeflowHome, ".env"),
			"CODEMARK_IDENTITY_PROBE=PROC_ENV_CANARY\n",
			"utf8",
		);
		const result = runCodemark([
			"--model", "codemark-offline/manager",
			"--timeout", "10",
			"Attempt to identify the measurement harness before organizing",
		], {
			cwd: repository,
			env: fakeEnvironment({
				CODEFLOW_HOME: codeflowHome,
				CODEFLOW_PI_CLI: REAL_PI,
				CODEMARK_OFFLINE_SCENARIO: "identity-probe",
			}),
			timeoutMs: 15_000,
		});

		expect(result.exitCode).toBe(0);
		const summary = JSON.parse(result.stdout.trim());
		const expectedRoot = path.join(codeflowHome, "codemark", "runs");
		expect(summary.artifact.startsWith(`${expectedRoot}${path.sep}`)).toBe(true);
		const outDir = path.dirname(summary.artifact);
		const artifact = readJson(summary.artifact);
		expect(artifact).toMatchObject({
			status: "completed",
			termination: "first_turn_end",
			manager_claim: { work: "identity boundary passed" },
			metrics: { delegate_count: 1, initial_worker_count: 1 },
			usage: { calls: 3 },
		});
		expect(fs.readdirSync(outDir).sort()).toEqual([
			"initial-organization.json",
			"request.json",
			"usage.json",
		]);
		expect(fs.existsSync(path.join(repository, ".codemark"))).toBe(false);
	});

	test("the real Pi loop preserves coercible tool calls", () => {
		const repository = makeTmpDir("codemark-coercible-repository-");
		const outDir = path.join(makeTmpDir("codemark-coercible-output-"), "run");
		const result = runCodemark([
			"--model", "codemark-offline/manager",
			"--out", outDir,
			"--timeout", "10",
			"Preserve Pi argument coercion",
		], {
			cwd: repository,
			env: fakeEnvironment({
				CODEFLOW_PI_CLI: REAL_PI,
				CODEMARK_OFFLINE_SCENARIO: "coercible-arguments",
			}),
			timeoutMs: 15_000,
		});

		expect(result.exitCode).toBe(0);
		const artifact = readJson(path.join(outDir, "initial-organization.json"));
		expect(artifact).toMatchObject({
			status: "completed",
			termination: "first_turn_end",
			manager_claim: { work: "123", done_when: ["frontier frozen"] },
			metrics: { delegate_count: 1, initial_worker_count: 1 },
			assessment: { organization_valid: true, policy_violations: [] },
			usage: { calls: 2 },
		});
		expect(artifact.delegations[0].focus).toBe("456");
	});

	test("a zero-Child first natural turn end is a successful measurement instead of a runtime failure", () => {
		const repository = makeTmpDir("codemark-zero-workers-repository-");
		const outDir = path.join(makeTmpDir("codemark-zero-workers-output-"), "run");
		const result = runCodemark([
			"--out", outDir,
			"Issue whose Agent chooses not to delegate",
		], {
			cwd: repository,
			env: fakeEnvironment({ CODEMARK_FAKE_PI_MODE: "zero-workers" }),
			timeoutMs: 15_000,
		});

		expect(result.exitCode).toBe(0);
		const artifact = readJson(path.join(outDir, "initial-organization.json"));
		expect(artifact).toMatchObject({
			status: "completed",
			termination: "first_turn_end",
			metrics: { delegate_count: 0, initial_worker_count: 0 },
			assessment: {
				organization_valid: false,
				policy_violations: ["manager_claim_missing"],
			},
			usage: { calls: 1, total_tokens: 159 },
		});
		expect(JSON.parse(result.stdout.trim())).toMatchObject({
			status: "completed",
			termination: "first_turn_end",
			metrics: { initial_worker_count: 0 },
		});
	});

	test("a clean Agent exit before natural turn end is an incomplete measurement", () => {
		const repository = makeTmpDir("codemark-exit-repository-");
		const outDir = path.join(makeTmpDir("codemark-exit-output-"), "run");
		const result = runCodemark([
			"--out", outDir,
			"Issue that exits before the frontier is frozen",
		], {
			cwd: repository,
			env: fakeEnvironment({ CODEMARK_FAKE_PI_MODE: "manager-exit" }),
			timeoutMs: 15_000,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/measurement ended with manager_exit/i);
		expect(readJson(path.join(outDir, "initial-organization.json"))).toMatchObject({
			status: "incomplete",
			termination: "manager_exit",
			metrics: { delegate_count: 3, initial_worker_count: 2 },
			usage: { calls: 1, total_tokens: 159 },
		});
		});

	test("a natural Agent exit wins over a later timeout while stdout is still draining", () => {
		const repository = makeTmpDir("codemark-exit-drain-repository-");
		const outDir = path.join(makeTmpDir("codemark-exit-drain-output-"), "run");
		const result = runCodemark([
			"--out", outDir,
			"--timeout", "1",
			"Exit before a descendant releases the output pipe",
		], {
			cwd: repository,
			env: fakeEnvironment({ CODEMARK_FAKE_PI_MODE: "manager-exit-drain-gap" }),
			timeoutMs: 15_000,
		});

		expect(result.exitCode).toBe(1);
		expect(readJson(path.join(outDir, "initial-organization.json"))).toMatchObject({
			status: "incomplete",
			termination: "manager_exit",
			usage: { calls: 1 },
		});
		});

	test("an Agent subprocess cannot hold inherited output pipes open forever", () => {
		const repository = makeTmpDir("codemark-exit-stuck-drain-repository-");
		const outDir = path.join(makeTmpDir("codemark-exit-stuck-drain-output-"), "run");
		const startedAt = Date.now();
		const result = runCodemark([
			"--out", outDir,
			"--timeout", "10",
			"Exit while a descendant holds the output pipes indefinitely",
		], {
			cwd: repository,
			env: fakeEnvironment({ CODEMARK_FAKE_PI_MODE: "manager-exit-stuck-drain" }),
			timeoutMs: 5_000,
		});

		expect(Date.now() - startedAt).toBeLessThan(4_000);
		expect(result.exitCode).toBe(1);
		expect(readJson(path.join(outDir, "initial-organization.json"))).toMatchObject({
			status: "incomplete",
			termination: "manager_exit",
			usage: { calls: 1 },
		});
	});

	test("a late signal cannot interrupt terminal artifact publication after Agent exit", () => {
		const repository = makeTmpDir("codemark-exit-drain-signal-repository-");
		const outputParent = makeTmpDir("codemark-exit-drain-signal-output-");
		const outDir = path.join(outputParent, "run");
		const signalMarker = path.join(outputParent, "late-signal-sent");
		const result = runCodemark([
			"--out", outDir,
			"--timeout", "10",
			"Publish after the Agent exits",
		], {
			cwd: repository,
			env: fakeEnvironment({
				CODEMARK_FAKE_PI_MODE: "manager-exit-drain-signal",
				CODEMARK_FAKE_SIGNAL_MARKER: signalMarker,
			}),
			timeoutMs: 15_000,
		});

		expect(fs.readFileSync(signalMarker, "utf8")).toBe("sent");
		expect(result.exitCode).toBe(1);
		expect(readJson(path.join(outDir, "initial-organization.json"))).toMatchObject({
			status: "incomplete",
			termination: "manager_exit",
			usage: { calls: 1 },
		});
	});

	test("keeps every inherited provider variable ahead of the convenience env file", () => {
		const repository = makeTmpDir("codemark-env-repository-");
		const outDir = path.join(makeTmpDir("codemark-env-output-"), "run");
		const codeflowHome = makeTmpDir("codemark-env-home-");
		fs.writeFileSync(path.join(codeflowHome, ".env"), [
			"CODEMARK_TEST_DYNAMIC_KEY=from-file",
			"CODEMARK_TEST_FILE_ONLY=from-file",
		].join("\n") + "\n", "utf8");
		const result = runCodemark(["--out", outDir, "Check dynamic credential precedence"], {
			cwd: repository,
			env: fakeEnvironment({
				CODEFLOW_HOME: codeflowHome,
				CODEMARK_FAKE_PI_MODE: "environment-precedence",
				CODEMARK_TEST_DYNAMIC_KEY: "from-shell",
			}),
			timeoutMs: 15_000,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("fake-pi:");
		expect(readJson(path.join(outDir, "initial-organization.json"))).toMatchObject({
			status: "completed",
			termination: "first_turn_end",
		});
	});

	test("provider length stop is reported as output_truncated", () => {
		const repository = makeTmpDir("codemark-length-repository-");
		const outDir = path.join(makeTmpDir("codemark-length-output-"), "run");
		const result = runCodemark(["--out", outDir, "Issue truncated before natural turn end"], {
			cwd: repository,
			env: fakeEnvironment({ CODEMARK_FAKE_PI_MODE: "length" }),
			timeoutMs: 15_000,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/measurement ended with output_truncated/i);
		const artifact = readJson(path.join(outDir, "initial-organization.json"));
		expect(artifact).toMatchObject({
			status: "incomplete",
			termination: "output_truncated",
			diagnostic: "Manager output reached the provider length limit before its first natural turn end",
			metrics: { delegate_count: 3, initial_worker_count: 2 },
		});
		const summary = JSON.parse(result.stdout.trim());
		expect(summary.metrics).toEqual(artifact.metrics);
	});

	for (const scenario of [
		{ mode: "error", termination: "provider_failure", status: "failed" },
		{ mode: "aborted", termination: "interrupted", status: "interrupted" },
	]) {
		test(`abnormal agent_end is not completion: ${scenario.mode}`, () => {
			const repository = makeTmpDir("codemark-abnormal-repository-");
			const outDir = path.join(makeTmpDir("codemark-abnormal-output-"), "run");
			const result = runCodemark(["--out", outDir, "Handle abnormal Manager output"], {
				cwd: repository, env: fakeEnvironment({ CODEMARK_FAKE_PI_MODE: scenario.mode }),
			});
			expect(result.exitCode).toBe(1);
			expect(readJson(path.join(outDir, "initial-organization.json"))).toMatchObject({
				status: scenario.status, termination: scenario.termination, usage: { calls: 1 },
			});
		});
	}

	for (const scenario of [
		{ mode: "provider-error", termination: "provider_failure", status: "failed" },
		{ mode: "length", termination: "output_truncated", status: "incomplete" },
		{ mode: "length-with-tools", termination: "output_truncated", status: "incomplete" },
		{ mode: "aborted", termination: "interrupted", status: "interrupted" },
	]) {
		test(`real offline Pi abnormal end: ${scenario.mode}`, () => {
			const repository = makeTmpDir("codemark-real-abnormal-repository-");
			const outDir = path.join(makeTmpDir("codemark-real-abnormal-output-"), "run");
			const result = runCodemark(["--model", "codemark-offline/manager", "--out", outDir, "--timeout", "10", "Handle abnormal Manager output"], {
				cwd: repository,
				env: fakeEnvironment({ CODEFLOW_PI_CLI: REAL_PI, CODEMARK_OFFLINE_SCENARIO: scenario.mode }),
				timeoutMs: 15_000,
			});
			expect(result.exitCode).toBe(1);
			expect(readJson(path.join(outDir, "initial-organization.json"))).toMatchObject({
				status: scenario.status, termination: scenario.termination, metrics: { delegate_count: 1 },
			});
		});
	}

	for (const scenario of [
		{ mode: "turn-end-before-timeout", expected: "first_turn_end", status: "completed", exitCode: 0, timeout: 1 },
		{ mode: "turn-end-after-timeout", expected: "timeout", status: "incomplete", exitCode: 1, timeout: 1 },
		{ mode: "turn-end-before-interrupt", expected: "first_turn_end", status: "completed", exitCode: 0, timeout: 10 },
		{ mode: "turn-end-after-interrupt", expected: "interrupted", status: "interrupted", exitCode: 1, timeout: 10 },
	] as const) {
		test(`the earlier cutoff wins for ${scenario.mode}`, () => {
			const repository = makeTmpDir(`codemark-${scenario.mode}-repository-`);
			const outDir = path.join(makeTmpDir(`codemark-${scenario.mode}-output-`), "run");
			const result = runCodemark([
				"--out", outDir,
				"--timeout", String(scenario.timeout),
				`Cutoff ordering ${scenario.mode}`,
			], {
				cwd: repository,
				env: fakeEnvironment({ CODEMARK_FAKE_PI_MODE: scenario.mode }),
				timeoutMs: 15_000,
			});
			expect(result.exitCode).toBe(scenario.exitCode);
			const artifact = readJson(path.join(outDir, "initial-organization.json"));
			expect(artifact).toMatchObject({
				status: scenario.status,
				termination: scenario.expected,
				metrics: { delegate_count: 3, initial_worker_count: 2 },
			});
			const summary = JSON.parse(result.stdout.trim());
			expect(summary.metrics).toEqual(artifact.metrics);
		});
	}
});
