#!/usr/bin/env bun
/**
 * Test-support fake of real-mode workspace provisioning
 * (tests/benchmark/fakes/README.md §3 — the seam contract).
 *
 * Spawned by the benchmark runner as:
 *   <this> <repo> <base_commit> <workspaceDir>
 *
 * Produces workspaceDir as a git working tree whose HEAD is exactly
 * base_commit, cloned from the local bare repo in FAKE_CLONE_SOURCE (no
 * network). The runner must invoke this before spawning the driver and must
 * never touch the source repo itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
function argValue(flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index !== -1 && index + 1 < args.length) return args[index + 1];
	return undefined;
}

// Contract form: <repo> <base_commit> <workspaceDir> (positional); explicit
// flags override for implementation freedom on the runner side.
const repo = argValue("--repo") ?? args[0];
const baseCommit = argValue("--base-commit") ?? args[1];
const dest = argValue("--dest") ?? args[2];

const capture = process.env.FAKE_CAPTURE_DIR;
if (capture) {
	fs.mkdirSync(capture, { recursive: true });
	fs.appendFileSync(
		path.join(capture, "clone-calls.jsonl"),
		`${JSON.stringify({ pid: process.pid, argv: args, repo, base_commit: baseCommit, dest })}\n`,
		"utf8",
	);
}

if (!repo || !baseCommit || !dest || !process.env.FAKE_CLONE_SOURCE) {
	process.stderr.write("fake-clone: expected <repo> <base_commit> <dest> and FAKE_CLONE_SOURCE\n");
	process.exit(1);
}

function run(cmd: string[], cwd?: string): number {
	const result = Bun.spawnSync(cmd, { cwd });
	if (result.exitCode !== 0) {
		process.stderr.write(result.stderr.toString());
	}
	return result.exitCode ?? 1;
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
if (run(["git", "clone", "--quiet", process.env.FAKE_CLONE_SOURCE, dest]) !== 0) process.exit(1);
if (run(["git", "checkout", "--quiet", baseCommit], dest) !== 0) process.exit(1);

const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dest });
if (head.stdout.toString().trim() !== baseCommit) {
	process.stderr.write(`fake-clone: HEAD ${head.stdout.toString().trim()} != base_commit ${baseCommit}\n`);
	process.exit(1);
}
process.exit(0);
