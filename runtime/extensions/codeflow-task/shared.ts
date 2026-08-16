/** Shared primitives used by both registry and role launching. */

import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";

export interface RoleRunResult {
	agent: string;
	success: boolean;
	content: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	stderr: string;
	aborted?: boolean;
}

/** Resolve the run paths for the run this process belongs to. */
export function currentRun(): RunPaths | null {
	const runId = process.env.CODEFLOW_RUN_ID;
	if (!runId) return null;
	return new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, runId);
}
