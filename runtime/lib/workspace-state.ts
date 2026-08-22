/** Mechanical workspace observations used by handoff telemetry. */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

export type WorkspaceChangedFiles = string[];

export function workspaceChangedFiles(
	cwd: string | undefined = process.env.CODEFLOW_PROJECT_DIR ?? process.cwd(),
): WorkspaceChangedFiles {
	if (!cwd) return [];
	const result = spawnSync(
		"git",
		["-C", cwd, "status", "--porcelain", "-z", "--untracked-files=all", "--no-renames"],
		{ encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
	);
	if (result.error || result.status !== 0) return [];
	const entries = result.stdout.toString("utf8").split("\0").filter((entry) => entry.length > 0);
	const files = new Set<string>();
	for (const entry of entries) {
		if (entry.length < 4) continue;
		files.add(path.normalize(entry.slice(3)).split(path.sep).join("/"));
	}
	return [...files].sort();
}

export function changedFilesDelta(
	before: WorkspaceChangedFiles | undefined,
	after: WorkspaceChangedFiles,
): string[] {
	const beforeSet = new Set(before ?? []);
	const afterSet = new Set(after);
	const delta = new Set<string>();
	for (const file of afterSet) if (!beforeSet.has(file)) delta.add(file);
	for (const file of beforeSet) if (!afterSet.has(file)) delta.add(file);
	return [...delta].sort();
}

export type AcceptanceContext = "fresh" | "producer";

export function deriveAcceptanceContext(
	before: WorkspaceChangedFiles | undefined,
	after: WorkspaceChangedFiles,
): AcceptanceContext {
	return changedFilesDelta(before, after).length > 0 ? "producer" : "fresh";
}
