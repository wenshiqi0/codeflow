/** Two-phase SWE evaluation for a Task organized by the outer host, never by Pi. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_RUNS_DIR, RunPaths, writeJsonAtomic } from "../../runtime/lib/paths";
import { teamStatus } from "../../runtime/lib/team";
import { buildUsageReport, readUsageRecords } from "../../runtime/lib/usage";
import { loadBenchmarkDataset, projectModelVisibleInstance } from "./dataset";
import { createProcessHarnessEvaluator, createSourceCloneWorkspaceProvisioner, type BenchmarkWorkspaceProvisioner } from "./process";
import { type BenchmarkEvaluator, type BenchmarkVerdict } from "./driver";
import { newBenchmarkRunId, newEvaluationRunId } from "./ids";
import { appendPredictionLine } from "./predictions";
import { defaultCodeflowCommit } from "./runner";
import { caseDirName, extractPatchDetailed, seedBenchmarkWorkspaceHygiene } from "./workspace";

export const PREPARED_MANIFEST = "prepared-run.json";
const HARNESS_COMMIT = "7a21e05772954cc81471ae19d56f436cecf43c54";

/** Grading data stays outside the measured execution, independent of delegation. */
function assertBenchmarkHost(): void {
	if (process.env.CODEFLOW_RUN_ID || process.env.CODEFLOW_EXECUTION_ID || process.env.CODEFLOW_TEAM_AGENT_ID) {
		throw new Error("benchmark preparation and evaluation must run outside the measured Pi execution");
	}
}

export interface PreparedCase {
	instance_id: string;
	repo: string;
	base_commit: string;
	workspace_head: string;
	workspace_tree: string;
}

export interface PreparedManifest {
	schema_version: 1;
	benchmark_run_id: string;
	execution_method: "outer-managed";
	created_at: string;
	codeflow_commit: string;
	dataset: { dataset_id: string; split: string; revision: string };
	harness: { commit: string };
	/** The outer host's existing conversation and tool network are not controlled here. */
	outer_context_isolation: "not_attested";
	tool_network: "not_attested";
	cases: PreparedCase[];
}

function safeId(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) throw new Error(`invalid artifact id: ${value}`);
	return value;
}

function caseDirectory(runDir: string, instanceId: string): string {
	return path.join(runDir, "cases", safeId(caseDirName(instanceId)), "attempts", "1");
}

function gitRead(workspace: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", workspace, ...args]);
	if (result.exitCode !== 0) throw new Error(`workspace git check failed: ${result.stderr.toString().trim().slice(-400)}`);
	return result.stdout.toString().trim();
}

export function readPreparedManifest(runDir: string): PreparedManifest {
	const value = JSON.parse(fs.readFileSync(path.join(runDir, PREPARED_MANIFEST), "utf8")) as PreparedManifest;
	if (value.schema_version !== 1 || value.execution_method !== "outer-managed" || !Array.isArray(value.cases) || value.cases.length === 0) {
		throw new Error("unsupported or malformed prepared benchmark");
	}
	safeId(value.benchmark_run_id);
	if (value.dataset?.split !== "test" || !/^[0-9a-f]{40}$/.test(value.dataset.revision) || !/^[0-9a-f]{40}$/.test(value.harness?.commit)) {
		throw new Error("prepared benchmark provenance is malformed");
	}
	for (const item of value.cases) {
		safeId(caseDirName(item.instance_id));
		for (const sha of [item.base_commit, item.workspace_head, item.workspace_tree]) {
			if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("prepared workspace provenance is malformed");
		}
	}
	if (new Set(value.cases.map((item) => item.instance_id)).size !== value.cases.length) throw new Error("duplicate prepared instance");
	return value;
}

export function prepareBenchmark(options: {
	dataset: string;
	instances: string[];
	outDir: string;
	provisionWorkspace?: BenchmarkWorkspaceProvisioner;
	codeflowCommit?: string;
}): { manifest: PreparedManifest; out_dir: string; cases: Array<{ instance_id: string; workspace: string; issue: string }> } {
	assertBenchmarkHost();
	if (options.instances.length === 0 || new Set(options.instances).size !== options.instances.length) throw new Error("prepare requires a nonempty unique instance allowlist");
	const dataset = loadBenchmarkDataset(options.dataset);
	if (dataset.split !== "test") throw new Error("the official evaluator supports the test split only");
	const selected = dataset.instances.filter((item) => options.instances.includes(item.instance_id));
	if (selected.length !== options.instances.length) throw new Error("prepare allowlist contains an unknown instance");
	for (const item of selected) safeId(caseDirName(item.instance_id));
	const outDir = path.resolve(options.outDir);
	// Never overwrite an earlier attempt, dangling symlink, or partial preparation.
	fs.mkdirSync(path.dirname(outDir), { recursive: true });
	fs.mkdirSync(outDir);
	const manifest: PreparedManifest = {
		schema_version: 1,
		benchmark_run_id: newBenchmarkRunId(),
		execution_method: "outer-managed",
		created_at: new Date().toISOString(),
		codeflow_commit: options.codeflowCommit ?? defaultCodeflowCommit(),
		dataset: { dataset_id: dataset.dataset_id, split: dataset.split, revision: dataset.revision },
		harness: { commit: dataset.harness_commit },
		outer_context_isolation: "not_attested",
		tool_network: "not_attested",
		cases: [],
	};
	const provision = options.provisionWorkspace ?? createSourceCloneWorkspaceProvisioner();
	const cases = selected.map((instance) => {
		const attemptDir = caseDirectory(outDir, instance.instance_id);
		const workspace = path.join(attemptDir, "workspace");
		const issue = path.join(attemptDir, "issue.json");
		fs.mkdirSync(attemptDir, { recursive: true });
		const projection = projectModelVisibleInstance(instance);
		provision(projection, workspace);
		seedBenchmarkWorkspaceHygiene(workspace);
		manifest.cases.push({
			instance_id: instance.instance_id,
			repo: instance.repo,
			base_commit: instance.base_commit,
			workspace_head: gitRead(workspace, "rev-parse", "HEAD"),
			workspace_tree: gitRead(workspace, "rev-parse", "HEAD^{tree}"),
		});
		writeJsonAtomic(issue, projection);
		return { instance_id: instance.instance_id, workspace, issue };
	});
	// Published only after every fresh workspace is ready. Failure leaves a visible,
	// unusable partial directory, never a fake ready manifest or model result.
	writeJsonAtomic(path.join(outDir, PREPARED_MANIFEST), manifest);
	return { manifest, out_dir: outDir, cases };
}

export interface PreparedEvaluation {
	schema_version: 1;
	instance_id: string;
	task_id: string;
	execution_method: "outer-managed";
	evaluation_run_id: string;
	verdict: BenchmarkVerdict;
	task_status: "completed" | "blocked";
	patch_sha256: string;
	patch_hygiene: { stripped_binary_paths: string[] };
	/** Official evaluator outcome is valid; an uncontaminated benchmark score isn't attested. */
	not_official: true;
	executor_usage: ReturnType<typeof buildUsageReport> | null;
	outer_host_usage: null;
	usage_scope: "Pi executors and internal services only; outer-host usage unavailable";
}

export async function evaluatePreparedBenchmark(options: {
	runDir: string;
	taskId: string;
	runsDir?: string;
	modelConfig: string;
	evaluator?: BenchmarkEvaluator;
	readTeamStatus?: typeof teamStatus;
}): Promise<PreparedEvaluation> {
	assertBenchmarkHost();
	safeId(options.taskId);
	const runDir = path.resolve(options.runDir);
	const manifest = readPreparedManifest(runDir);
	const matches = manifest.cases.flatMap((item) => {
		const workspace = path.join(caseDirectory(runDir, item.instance_id), "workspace");
		const runs = path.resolve(options.runsDir ?? process.env.CODEFLOW_RUNS_DIR ?? path.join(workspace, DEFAULT_RUNS_DIR));
		const paths = new RunPaths(runs, options.taskId);
		if (!fs.existsSync(paths.task)) return [];
		const state = (options.readTeamStatus ?? teamStatus)(paths);
		return fs.realpathSync(state.project_dir) === fs.realpathSync(workspace) ? [{ item, workspace, paths, state }] : [];
	});
	if (matches.length !== 1) throw new Error("--task must identify exactly one prepared workspace's outer-managed Task");
	const { item, workspace, paths, state } = matches[0];
	if (!["completed", "blocked"].includes(state.status) || state.open_commitments.length !== 0 || state.agents.some((agent) =>
		!["idle", "interrupted"].includes(agent.status) || agent.pid !== null || agent.runner_pid !== null)) {
		throw new Error("evaluate requires codeteam finish, no open Commitments, and every executor fully stopped");
	}
	if (gitRead(workspace, "rev-parse", "HEAD") !== item.workspace_head || gitRead(workspace, "rev-parse", "HEAD^{tree}") !== item.workspace_tree) {
		throw new Error("workspace baseline changed; leave the fix uncommitted before evaluation");
	}
	if (!options.evaluator && manifest.harness.commit !== HARNESS_COMMIT) throw new Error("prepared harness revision does not match the pinned official evaluator");
	if (process.env.CODEFLOW_BENCHMARK_EVAL_DATASET && process.env.CODEFLOW_BENCHMARK_EVAL_DATASET !== manifest.dataset.dataset_id) {
		throw new Error("evaluator dataset override conflicts with the prepared dataset");
	}
	const evaluationDir = path.join(caseDirectory(runDir, item.instance_id), "evaluation");
	// Exclusive directory reserves this one evaluation before patch extraction. No
	// repeated command may silently rerun the evaluator or overwrite a frozen patch.
	fs.mkdirSync(evaluationDir);
	const extraction = extractPatchDetailed(workspace);
	const prediction = { instance_id: item.instance_id, model_name_or_path: `codeflow-outer-managed:${options.modelConfig}`, model_patch: extraction.patch };
	const predictionsFile = path.join(evaluationDir, "prediction.jsonl");
	appendPredictionLine(predictionsFile, prediction);
	const evaluationRunId = newEvaluationRunId(manifest.benchmark_run_id, item.instance_id, 1);
	let verdict: BenchmarkVerdict;
	try {
		const evaluator = options.evaluator ?? createProcessHarnessEvaluator({ env: { ...process.env, CODEFLOW_BENCHMARK_EVAL_DATASET: manifest.dataset.dataset_id } });
		verdict = await evaluator.evaluate({ prediction, instanceId: item.instance_id, evaluationRunId, predictionsFile });
		if (!["resolved", "unresolved", "infra_error", "not_evaluated"].includes(verdict)) verdict = "infra_error";
	} catch {
		verdict = "infra_error";
	}
	const record: PreparedEvaluation = {
		schema_version: 1,
		instance_id: item.instance_id,
		task_id: options.taskId,
		execution_method: "outer-managed",
		evaluation_run_id: evaluationRunId,
		verdict,
		task_status: state.status as "completed" | "blocked",
		patch_sha256: createHash("sha256").update(extraction.patch).digest("hex"),
		patch_hygiene: { stripped_binary_paths: extraction.strippedBinaryPaths },
		not_official: true,
		executor_usage: fs.existsSync(paths.usageLedger) ? buildUsageReport(options.taskId, readUsageRecords(paths)) : null,
		outer_host_usage: null,
		usage_scope: "Pi executors and internal services only; outer-host usage unavailable",
	};
	writeJsonAtomic(path.join(evaluationDir, "result.json"), record);
	return record;
}

/** Historical results only; never starts or retries an evaluator. */
export function reportPreparedBenchmark(runDir: string) {
	const manifest = readPreparedManifest(runDir);
	const cases = manifest.cases.map((item) => {
		const file = path.join(caseDirectory(runDir, item.instance_id), "evaluation", "result.json");
		if (!fs.existsSync(file)) return { instance_id: item.instance_id, verdict: "not_evaluated" as const };
		const result = JSON.parse(fs.readFileSync(file, "utf8")) as PreparedEvaluation;
		if (result.schema_version !== 1 || result.instance_id !== item.instance_id || result.execution_method !== "outer-managed"
			|| !["resolved", "unresolved", "infra_error", "not_evaluated"].includes(result.verdict)
			|| result.evaluation_run_id !== newEvaluationRunId(manifest.benchmark_run_id, item.instance_id, 1)) {
			throw new Error("malformed prepared evaluation result");
		}
		return result;
	});
	return { schema_version: 1, benchmark_run_id: manifest.benchmark_run_id, execution_method: "outer-managed" as const, not_official: true, outer_host_usage: null, cases };
}
