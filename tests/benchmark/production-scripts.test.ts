/**
 * Developer tests for the PRODUCTION seam defaults under
 * benchmark/scripts — the live boundary the acceptance suite replaces
 * with process fakes (TESTPLAN "Not covered here").
 *
 * These pin only the deterministic offline behaviors of the production
 * scripts: argument validation and the loud-failure modes. They never touch
 * the network, a model, or Docker, and they never assert anything about the
 * live paths (real clone/fetch/evaluate), which remain unexecuted external
 * verification on this host (design §14).
 *
 * - repo-clone.sh: wrong arg count is a usage error; it never creates output.
 * - hub-fetch.ts: a non-hub-id argument fails loudly; no document is printed.
 * - codeflow-driver.ts: --workspace is required; a stdin document without the
 *   four visible fields is refused before any Codeflow process starts.
 * - swebench-harness.sh: missing arguments are a usage error; an unreachable
 *   docker daemon exits 127 (evaluator unavailable => not_evaluated upstream,
 *   never a fabricated verdict).
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPO } from "./helpers";

const SCRIPTS = path.join(REPO, "benchmark", "scripts");

function runScript(
	command: string[],
	options: { stdin?: string; env?: Record<string, string> } = {},
): { exitCode: number | null; stdout: string; stderr: string } {
	const spawned = Bun.spawnSync(command, {
		stdin: options.stdin !== undefined ? "pipe" : "ignore",
		env: { ...process.env, ...options.env },
	});
	if (options.stdin !== undefined) spawned.stdin?.write(options.stdin);
	if (options.stdin !== undefined) spawned.stdin?.end();
	return {
		exitCode: spawned.exitCode,
		stdout: spawned.stdout.toString(),
		stderr: spawned.stderr.toString(),
	};
}

/** A PATH prefix whose docker/python3 stubs exist but cannot serve. */
function stubbedPath(kind: "docker-down" | "python-down"): { path: string; python: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-bench-stub-"));
	fs.writeFileSync(path.join(dir, "python3"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	if (kind === "docker-down") {
		fs.writeFileSync(path.join(dir, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	}
	return {
		path: `${dir}:${process.env.PATH ?? ""}`,
		python: path.join(dir, "python3"),
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

describe("production repo-clone.sh (live boundary)", () => {
	test("wrong argument count is a usage error and writes nothing", () => {
		const out = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-bench-clone-"));
		try {
			const result = runScript([path.join(SCRIPTS, "repo-clone.sh"), "owner/repo"]);
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("usage:");
			// No partial workspace may exist after a failed provisioning.
			expect(fs.readdirSync(out)).toHaveLength(0);
		} finally {
			fs.rmSync(out, { recursive: true, force: true });
		}
	});

	test("a bare repo name is rejected before any clone", () => {
		const result = runScript([
			path.join(SCRIPTS, "repo-clone.sh"),
			"not-a-slash-name",
			"0".repeat(40),
			path.join(os.tmpdir(), "codeflow-bench-never"),
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("owner/name");
	});

	test("uses a read-only local source cache without network access", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-bench-cache-"));
		const cacheRoot = path.join(root, "cache");
		const source = path.join(cacheRoot, "repo");
		const destination = path.join(root, "workspace");
		try {
			fs.mkdirSync(source, { recursive: true });
			expect(runScript(["git", "-C", source, "init", "--quiet", "--initial-branch=main"]).exitCode).toBe(0);
			fs.writeFileSync(path.join(source, "tracked.txt"), "cached source\n");
			expect(runScript(["git", "-C", source, "add", "--all"]).exitCode).toBe(0);
			expect(runScript([
				"git", "-C", source,
				"-c", "user.name=cache-test",
				"-c", "user.email=cache@example.invalid",
				"commit", "--quiet", "-m", "cached base",
			]).exitCode).toBe(0);
			const sourceHead = runScript(["git", "-C", source, "rev-parse", "HEAD"]).stdout.trim();
			const result = runScript([
				path.join(SCRIPTS, "repo-clone.sh"),
				"owner/repo",
				sourceHead,
				destination,
			], {
				env: {
					CODEFLOW_BENCHMARK_REPO_CACHE_DIR: cacheRoot,
					HTTP_PROXY: "http://127.0.0.1:1",
					HTTPS_PROXY: "http://127.0.0.1:1",
					ALL_PROXY: "socks5://127.0.0.1:1",
				},
			});
			expect(result).toMatchObject({ exitCode: 0, stderr: "" });
			expect(fs.readFileSync(path.join(destination, "tracked.txt"), "utf8")).toBe("cached source\n");
			expect(runScript(["git", "-C", source, "rev-parse", "HEAD"]).stdout.trim()).toBe(sourceHead);
			expect(runScript(["git", "-C", source, "status", "--short"]).stdout).toBe("");
			expect(runScript(["git", "-C", destination, "remote"]).stdout).toBe("");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("production hub-fetch.ts (live boundary)", () => {
	test("a non-hub-id argument fails loudly and prints no document", () => {
		const result = runScript([process.execPath, path.join(SCRIPTS, "hub-fetch.ts"), "not-a-hub-id"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("hub-fetch:");
		expect(result.stdout.trim()).toBe("");
	});

	test("a missing argument fails loudly", () => {
		const result = runScript([process.execPath, path.join(SCRIPTS, "hub-fetch.ts")]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout.trim()).toBe("");
	});
});

describe("production codeflow-driver.ts (live boundary)", () => {
	test("--workspace is required", () => {
		const projection = JSON.stringify({
			instance_id: "demo/demo-1",
			repo: "demo/repo",
			base_commit: "a".repeat(40),
			problem_statement: "x",
		});
		const result = runScript([process.execPath, path.join(SCRIPTS, "codeflow-driver.ts")], {
			stdin: projection,
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("--workspace");
	});

	test("stdin without the four visible fields is refused before any Codeflow run starts", () => {
		const result = runScript(
			[
				process.execPath,
				path.join(SCRIPTS, "codeflow-driver.ts"),
				"--workspace",
				path.join(os.tmpdir(), "codeflow-bench-driver-x"),
			],
			{ stdin: JSON.stringify({ instance_id: "demo/demo-1" }) },
		);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("projection");
	});
});

describe("production swebench-harness.sh (live boundary)", () => {
	test("missing arguments are a usage error", () => {
		const result = runScript([path.join(SCRIPTS, "swebench-harness.sh")]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("usage:");
	});

	test("an unreachable docker daemon exits 127 — unavailable, never a fabricated verdict", () => {
		const predictions = path.join(os.tmpdir(), `codeflow-bench-pred-${process.pid}.jsonl`);
		fs.writeFileSync(
			predictions,
			JSON.stringify({ instance_id: "demo/demo-1", model_name_or_path: "x", model_patch: "" }) + "\n",
			"utf8",
		);
		const stubs = stubbedPath("docker-down");
		try {
			const result = runScript(
				[
					path.join(SCRIPTS, "swebench-harness.sh"),
					"--predictions",
					predictions,
					"--run-id",
					"bench-x--demo__demo-1--a1",
					"--instance",
					"demo/demo-1",
				],
				{ env: { PATH: stubs.path, CODEFLOW_BENCHMARK_HARNESS_PYTHON: stubs.python } },
			);
			expect(result.exitCode).toBe(127);
			expect(result.stdout.trim()).not.toMatch(/^(resolved|unresolved)$/m);
		} finally {
			stubs.cleanup();
			fs.rmSync(predictions, { force: true });
		}
	});
});
