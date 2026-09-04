/** Real Pi + production organization, with deterministic offline model and Child processes. */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import organization from "../../../runtime/extensions/codeflow-organization";
import { delegateWorker, hasLiveWorkers } from "../../../runtime/extensions/codeflow-organization/worker-launcher";
import { claimCommitment, goalClaimRevision, loadTerminalReceipt, submitReceipt } from "../../../runtime/lib/commitment";
import { RunPaths } from "../../../runtime/lib/paths";

const paths = new RunPaths(process.env.CODEFLOW_RUNS_DIR!, process.env.CODEFLOW_RUN_ID!);
const resultFile = path.join(process.env.CODEFLOW_TEST_DIR!, "result.json");
const scenario = process.env.CODEFLOW_TEST_SCENARIO ?? "feedback";
const state = { calls: 0, testerSeenWhileDeveloperLive: false, naturalEnds: 0, killed: [] as string[] };
const children: FakeChild[] = [];
const timers: ReturnType<typeof setTimeout>[] = [];
let started = false;
let progressId: string | undefined;
let inspected = false;

class FakeChild extends EventEmitter {
	pid = 700_000 + children.length;
	stdout = new PassThrough();
	stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode = null;
	constructor(readonly id: string) { super(); children.push(this); }
	close(code = 0) { if (this.exitCode === null) { this.exitCode = code; this.emit("close", code); } }
	kill(signal: string) { state.killed.push(`${this.id}:${signal}`); queueMicrotask(() => this.close(1)); return true; }
}

function later(ms: number, action: () => void) { timers.push(setTimeout(action, ms)); }

function launch(id: string, parentId: string) {
	const child = new FakeChild(id);
	delegateWorker({ goalId: paths.runId, parentCommitmentId: parentId, focus: id }, undefined, process.cwd(), {
		executionId: id,
		resolve: () => ({ provider: "offline", model: "child", promptPaths: [], systemPrompts: [] }),
		spawnProcess: (() => child) as never,
	});
	return child;
}

function claim(id: string, parentId: string) {
	return claimCommitment(paths, {
		goalId: paths.runId, parentCommitmentId: parentId, workerExecutionId: id,
		basedOnRevision: goalClaimRevision(paths, paths.runId), work: id,
	});
}

const provider = fauxProvider({
	api: "codeflow-feedback-offline-api", provider: "codeflow-feedback-offline",
	models: [{ id: "manager", name: "Offline Manager", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096 }],
});
provider.setResponses(Array.from({ length: 20 }, () => (context) => {
	state.calls++;
	if (scenario === "retry" && state.calls === 2) throw new Error("429 rate limit exceeded (offline fixture)");
	const parentId = process.env.CODEFLOW_COMMITMENT_ID;
	if (!parentId) return fauxAssistantMessage([fauxToolCall("collaborate", {
		action: { name: "claim", work: "coordinate nonblocking feedback" },
	})]);
	if (progressId && JSON.stringify(context.messages).includes(progressId) && !inspected) {
		inspected = true;
		state.testerSeenWhileDeveloperLive = children[0]?.exitCode === null;
		return fauxAssistantMessage([fauxToolCall("collaborate", {
			action: { name: "inspect", receipt_id: progressId },
		})]);
	}
	if (hasLiveWorkers()) return fauxAssistantMessage([{ type: "text", text: "Independent work is in progress." }]);
	if (!loadTerminalReceipt(paths, parentId)) return fauxAssistantMessage([fauxToolCall("collaborate", {
		action: { name: "report", status: "completed", summary: "All Child feedback reconciled." },
	})]);
	return fauxAssistantMessage([{ type: "text", text: "Task complete." }]);
}));

export default function (pi: ExtensionAPI): void {
	// Register the actual production factory and its shared feedback scheduler.
	organization(pi);
	pi.registerProvider(provider.provider);
	pi.on("tool_result", (event, ctx) => {
		if (started || event.toolName !== "collaborate" || event.isError) return;
		const parentId = process.env.CODEFLOW_COMMITMENT_ID;
		if (!parentId) return;
		started = true;
		const developer = launch("exec-developer", parentId);
		const tester = launch("exec-tester", parentId);
		later(100, () => {
			const development = claim(developer.id, parentId);
			const testing = claim(tester.id, parentId);
			if (scenario === "abort") { later(300, () => ctx.abort()); return; }
			later(500, () => {
				progressId = submitReceipt(paths, { commitmentId: testing.id, status: "progress", summary: "Counterexample found." }).id;
			});
			later(1050, () => {
				submitReceipt(paths, { commitmentId: testing.id, status: "completed", summary: "Independent verification complete." });
				tester.close();
			});
			later(1600, () => {
				submitReceipt(paths, { commitmentId: development.id, status: "completed", summary: "Development complete." });
				developer.close();
			});
		});
	});
	pi.on("agent_end", () => { state.naturalEnds++; });
	pi.on("session_shutdown", () => {
		for (const timer of timers) clearTimeout(timer);
		fs.writeFileSync(resultFile, JSON.stringify(state));
	});
}
