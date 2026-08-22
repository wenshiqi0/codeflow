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
import * as path from "node:path";

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

const WORKSPACE_EXCLUDES = [
	".codeflow/",
	"codeflow-runs/",
	"*.bak",
	"*.orig",
	"*.rej",
] as const;

const DIFF_EXCLUDE_PATHS = [
	":(exclude).codeflow",
	":(exclude)codeflow-runs",
	":(exclude)*.bak",
	":(exclude)*.orig",
	":(exclude)*.rej",
] as const;

export interface PatchExtraction {
	patch: string;
	/** Files whose binary hunks were removed from the official prediction. */
	strippedBinaryPaths: string[];
}

/** Seed git-local excludes without changing the checked-out working tree. */
export function seedBenchmarkWorkspaceHygiene(dir: string): void {
	const excludeDir = path.join(dir, ".git", "info");
	const excludeFile = path.join(excludeDir, "exclude");
	fs.mkdirSync(excludeDir, { recursive: true });
	const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
	const existingLines = new Set(
		existing.split("\n").map((line) => line.trim()).filter((line) => line.length > 0),
	);
	const additions = WORKSPACE_EXCLUDES.filter((pattern) => !existingLines.has(pattern));
	if (additions.length === 0) return;
	const next = existing.length === 0 || existing.endsWith("\n")
		? existing + additions.join("\n") + "\n"
		: `${existing}\n${additions.join("\n")}\n`;
	fs.writeFileSync(excludeFile, next, "utf8");
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
	seedBenchmarkWorkspaceHygiene(dir);
}

function binaryPathsFromNumstat(output: string): string[] {
	const paths: string[] = [];
	for (const line of output.split("\n")) {
		const fields = line.split("\t");
		if (fields.length >= 3 && fields[0] === "-" && fields[1] === "-") {
			const filePath = fields.slice(2).join("\t");
			if (filePath.length > 0) paths.push(filePath);
		}
	}
	return paths;
}

function stripBinarySections(diff: string, binaryPaths: string[]): string {
	if (binaryPaths.length === 0) return diff;
	const wanted = new Set(binaryPaths);
	return diff
		.split(/(?=^diff --git )/m)
		.filter((section) => {
			const firstLine = section.split("\n", 1)[0];
			let keep = true;
			for (const filePath of wanted) {
				if (firstLine === `diff --git a/${filePath} b/${filePath}`) {
					keep = false;
					break;
				}
			}
			return keep;
		})
		.join("");
}

/** git add -A, then a hygiene-filtered cached diff and binary audit. */
export function extractPatchDetailed(dir: string): PatchExtraction {
	const diffArgs = ["-C", dir, "diff", "--cached", "--binary", "HEAD", "--", ".", ...DIFF_EXCLUDE_PATHS];
	git(["-C", dir, "add", "-A"]);
	const numstat = git([
		"-C",
		dir,
		"diff",
		"--cached",
		"--numstat",
		"HEAD",
		"--",
		".",
		...DIFF_EXCLUDE_PATHS,
	]);
	const strippedBinaryPaths = binaryPathsFromNumstat(numstat).sort();
	const patch = stripBinarySections(git(diffArgs), strippedBinaryPaths);
	return { patch, strippedBinaryPaths };
}

/** Backward-compatible string patch API used by older callers and tests. */
export function extractPatch(dir: string): string {
	return extractPatchDetailed(dir).patch;
}
