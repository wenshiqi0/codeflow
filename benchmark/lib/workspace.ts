/**
 * Isolated attempt workspaces and offline patch extraction (contract §1.7).
 *
 * `git init` plus one empty initial commit with a fixed identity — no network,
 * no clone of the dataset cache or any Codeflow checkout (design §4: the
 * benchmark runner must not mutate dataset caches, source clones, or
 * Codeflow's own checkouts). The patch is the cached binary diff against
 * HEAD, idempotent on repeated extraction.
 */

import * as fs from "node:fs";

const GIT_IDENTITY = [
	"-c",
	"user.name=codeflow-benchmark",
	"-c",
	"user.email=benchmark@codeflow.invalid",
	"-c",
	"commit.gpgsign=false",
];

function git(args: string[], cwd?: string): string {
	const result = Bun.spawnSync(["git", ...args], { cwd });
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (${result.exitCode ?? "signal"}): ` +
				new TextDecoder().decode(result.stderr).trim(),
		);
	}
	return new TextDecoder().decode(result.stdout);
}

/** instance_id with every `/` replaced by `__` (SWE-bench ids embed `owner/repo`). */
export function caseDirName(instanceId: string): string {
	return instanceId.replace(/\//g, "__");
}

/** git init + one initial empty commit with a fixed identity; no network. */
export function prepareBenchmarkWorkspace(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	git(["init", "--quiet"], dir);
	git(["-C", dir, ...GIT_IDENTITY, "commit", "--quiet", "--allow-empty", "-m", "codeflow benchmark workspace base"]);
}

/** git add -A, then the cached binary diff against HEAD; "" when nothing changed. */
export function extractPatch(dir: string): string {
	git(["-C", dir, "add", "-A"]);
	return git(["-C", dir, "diff", "--cached", "--binary", "HEAD"]);
}
