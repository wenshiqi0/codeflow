/**
 * `codeflow stop` must terminate the whole depth-0 process tree, not just the
 * recorded supervisor pid.
 *
 * The exec supervisor (cli-run) spawns pi, and pi spawns its own children.
 * If stop signals only the supervisor, a pi descendant outlives the run it
 * belongs to and keeps burning provider quota on work nobody is watching —
 * `stopped: true` becomes a lie. These tests build a deterministic tree with
 * a fake pi (no provider, no network) and prove stop — and the supervisor's
 * own signal forwarding — kill every member of the tree.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dir, "..", "..");
const OUTER = path.join(REPO, "runtime", "bin", "codeflow");

/** The fake pi learns where to write its process-tree identity from this. */
const TREE_ENV = "CODEFLOW_FAKE_PI_TREE";

function baseEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.CODEFLOW_RUN_ID;
	delete env.CODEFLOW_RUNS_DIR;
	return env;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const tmpDirs: string[] = [];
const procs: Bun.Subprocess[] = [];

function makeTmp(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

interface Fixture {
	dir: string;
	runsDir: string;
	fakePi: string;
	treeFile: string;
}

interface Tree {
	pi_pid: number;
	descendant_pid: number;
}

/**
 * Best-effort identity recovery for cleanup. The fake pi writes its tree file
 * before runner.json gains a child identity, so a test that fails while
 * waiting must still be able to find — and kill — every pid it caused.
 */
function readTreeFile(treeFile: string): Tree | null {
	try {
		return JSON.parse(fs.readFileSync(treeFile, "utf-8")) as Tree;
	} catch {
		return null;
	}
}

function readRunnerPids(runsDir: string): number[] {
	const pids: number[] = [];
	let runIds: string[];
	try {
		runIds = fs.readdirSync(runsDir).filter((name) => !name.startsWith("_"));
	} catch {
		return pids;
	}
	for (const runId of runIds) {
		try {
			const runner = JSON.parse(fs.readFileSync(path.join(runsDir, runId, "runner.json"), "utf-8"));
			for (const key of ["pid", "child_pid", "pgid"]) {
				if (typeof runner[key] === "number") pids.push(runner[key]);
			}
		} catch {
			// A half-written runner.json is one missing pid, not a failure.
		}
	}
	return pids;
}

/**
 * A fake pi that stands in for the real agent CLI: it spawns one long-lived
 * descendant, records both pids, and idles. That gives the test a two-level
 * process tree to kill without any provider call.
 */
const FAKE_PI_SOURCE = `import * as fs from "node:fs";

const descendant = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
fs.writeFileSync(
	process.env.${TREE_ENV} as string,
	JSON.stringify({ pi_pid: process.pid, descendant_pid: descendant.pid }),
);
await Bun.sleep(600_000);
`;

function makeFixture(): Fixture {
	const dir = makeTmp("codeflow-stop-tree-");
	const runsDir = makeTmp("codeflow-stop-tree-runs-");
	const fakePi = path.join(dir, "fake-pi.ts");
	fs.writeFileSync(fakePi, FAKE_PI_SOURCE);
	return { dir, runsDir, fakePi, treeFile: path.join(dir, "tree.json") };
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await Bun.sleep(100);
	}
	return cond();
}

/**
 * Wait until the run exists and runner.json records the depth-0 child
 * identity. The recorded child_pid (or pgid) must be the fake pi's pid —
 * stop can only kill a tree whose root identity the run has actually stored.
 */
async function waitForTree(
	runsDir: string,
	treeFile: string,
	timeoutMs = 10_000,
): Promise<{ runId: string; runner: Record<string, unknown>; tree: Tree }> {
	let found: { runId: string; runner: Record<string, unknown>; tree: Tree } | null = null;
	const ok = await waitFor(() => {
		let tree: Tree;
		try {
			tree = JSON.parse(fs.readFileSync(treeFile, "utf-8")) as Tree;
		} catch {
			return false;
		}
		let runIds: string[];
		try {
			runIds = fs.readdirSync(runsDir).filter((name) => !name.startsWith("_"));
		} catch {
			return false;
		}
		for (const runId of runIds) {
			let runner: Record<string, unknown>;
			try {
				runner = JSON.parse(fs.readFileSync(path.join(runsDir, runId, "runner.json"), "utf-8"));
			} catch {
				continue;
			}
			const child = runner.child_pid ?? runner.pgid;
			if (typeof child === "number" && child === tree.pi_pid) {
				found = { runId, runner, tree };
				return true;
			}
		}
		return false;
	}, timeoutMs);
	if (!ok || found === null) {
		throw new Error("runner.json never recorded the depth-0 child identity (child_pid/pgid)");
	}
	return found;
}

function spawnExec(fixture: Fixture): Bun.Subprocess {
	const env: Record<string, string> = {
		...baseEnv(),
		CODEFLOW_RUNS_DIR: fixture.runsDir,
		CODEFLOW_PI_CLI: fixture.fakePi,
		[TREE_ENV]: fixture.treeFile,
	};
	// No CODEFLOW_RUN_ID: exec starts a fresh depth-0 run.
	const proc = Bun.spawn(["bash", OUTER, "exec", "stop tree test requirement"], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	procs.push(proc);
	return proc;
}

function stopRun(runsDir: string, runId: string) {
	return Bun.spawnSync(["bash", OUTER, "stop", runId], {
		env: { ...baseEnv(), CODEFLOW_RUNS_DIR: runsDir },
		timeout: 30_000,
	});
}

/**
 * Kill anything that survived, however the test failed. Identities are read
 * back from disk rather than trusted from the test's own progress, so a
 * failure while waiting for runner.json still cleans up the tree it caused.
 *
 * A group kill keyed on the pi pid is only effective when pi was detached
 * into its own group (pgid == pi pid); without detachment the group id does
 * not exist and the call is a harmless ESRCH — it can never hit this test
 * process's own group.
 */
function killTree(fixture: Fixture, proc: Bun.Subprocess): void {
	const tree = readTreeFile(fixture.treeFile);
	if (tree !== null) {
		for (const pid of [tree.descendant_pid, tree.pi_pid]) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already dead.
			}
		}
		try {
			process.kill(-tree.pi_pid, "SIGKILL");
		} catch {
			// No such group — pi was never detached, nothing more to do.
		}
	}
	for (const pid of readRunnerPids(fixture.runsDir)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already dead.
		}
	}
	try {
		proc.kill("SIGKILL");
	} catch {
		// Already dead.
	}
}

afterEach(() => {
	for (const proc of procs.splice(0)) {
		try {
			proc.kill("SIGKILL");
		} catch {
			// Already dead — e.g. `codeflow stop` did its job.
		}
	}
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("stop terminates the depth-0 process tree", () => {
	test("stop kills the fake pi, its descendant, and the supervisor", async () => {
		const fixture = makeFixture();
		const proc = spawnExec(fixture);
		try {
			const { runId, runner, tree } = await waitForTree(fixture.runsDir, fixture.treeFile);
			// exec always drives the planner; choosing a role is never the
			// outer caller's job.
			expect(runner.role).toBe("planner");
			expect(typeof runner.pid).toBe("number");

			const stopped = stopRun(fixture.runsDir, runId);
			expect(stopped.exitCode).toBe(0);
			expect(JSON.parse(stopped.stdout.toString()).stopped).toBe(true);

			// stop must verify death, so a bounded poll is generous, not tight.
			const gone = await waitFor(
				() =>
					!pidAlive(tree.pi_pid) &&
					!pidAlive(tree.descendant_pid) &&
					proc.exitCode !== null,
				10_000,
			);
			expect(gone).toBe(true);
		} finally {
			killTree(fixture, proc);
		}
	}, 30_000);

	test("the supervisor forwards SIGTERM to the pi process group", async () => {
		// Defense in depth: even when stop is never called — the supervisor is
		// killed directly — the tree must not outlive it.
		const fixture = makeFixture();
		const proc = spawnExec(fixture);
		try {
			const { runner, tree } = await waitForTree(fixture.runsDir, fixture.treeFile);
			expect(runner.role).toBe("planner");
			const supervisorPid = runner.pid as number;
			expect(typeof supervisorPid).toBe("number");

			process.kill(supervisorPid, "SIGTERM");

			const gone = await waitFor(
				() =>
					!pidAlive(tree.pi_pid) &&
					!pidAlive(tree.descendant_pid) &&
					proc.exitCode !== null,
				10_000,
			);
			expect(gone).toBe(true);
		} finally {
			killTree(fixture, proc);
		}
	}, 30_000);
});
