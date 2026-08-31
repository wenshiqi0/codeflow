import { claimCommitment, goalClaimRevision, type ClaimOptions } from "../../runtime/lib/commitment";
import { RunPaths } from "../../runtime/lib/paths";

let executionSequence = 0;

export function claimTestWork(
	paths: RunPaths,
	options: Omit<ClaimOptions, "workerExecutionId" | "basedOnRevision" | "pid"> & {
		workerExecutionId?: string;
		pid?: number;
	},
) {
	const workerExecutionId = options.workerExecutionId ?? `test-execution-${++executionSequence}`;
	return claimCommitment(paths, {
		...options,
		workerExecutionId,
		basedOnRevision: goalClaimRevision(paths, options.goalId),
		pid: options.pid ?? process.pid,
	});
}
