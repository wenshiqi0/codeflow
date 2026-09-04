/** Runtime-owned feedback scheduling. No model-facing blocking tool. */
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadTerminalReceipt } from "../../lib/commitment";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import {
	cancelWorkers,
	hasLiveWorkers,
	takeWorkerUpdates,
	type WorkerFeedback,
} from "./worker-launcher";

export const FEEDBACK_POLL_MS = 250;
const MAX_UPDATES_PER_MESSAGE = 32;

interface FeedbackSource {
	takeWorkerUpdates(): WorkerFeedback[];
	hasLiveWorkers(): boolean;
	cancelWorkers(): void;
	rootClosed?(): boolean;
}

function rootClosed(): boolean {
	const taskId = process.env.CODEFLOW_RUN_ID;
	const commitmentId = process.env.CODEFLOW_COMMITMENT_ID;
	return Boolean(taskId && commitmentId && loadTerminalReceipt(
		new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, taskId), commitmentId,
	));
}

/** Only existing object references and bounded Runtime metadata enter the prompt. */
function project(update: WorkerFeedback) {
	return {
		execution_id: update.execution_id,
		goal_id: update.goal_id,
		commitment_id: update.commitment_id,
		...("receipt_id" in update ? { receipt_id: update.receipt_id } : {}),
		status: update.status,
		...("exit_code" in update ? {
			exit_code: update.exit_code,
			runtime_failure_reasons: update.runtime_failure_reasons,
			...(update.report ? { report: {
				summary: update.report.summary.slice(0, 600),
				remaining: update.report.remaining.slice(0, 4).map((item) => item.slice(0, 600)),
			} } : {}),
		} : {}),
	};
}

export function registerWorkerFeedback(pi: ExtensionAPI, source: FeedbackSource = {
	takeWorkerUpdates, hasLiveWorkers, cancelWorkers, rootClosed,
}): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let active = false;
	let disposed = false;
	let wake: (() => void) | undefined;
	let detachAbort: (() => void) | undefined;
	let currentContext: ExtensionContext | undefined;
	const pending: WorkerFeedback[] = [];
	const isClosed = source.rootClosed ?? rootClosed;

	const release = () => { const resolve = wake; wake = undefined; resolve?.(); };
	const dispose = () => {
		disposed = true;
		active = false;
		if (timer) clearInterval(timer);
		timer = undefined;
		detachAbort?.();
		detachAbort = undefined;
		pending.length = 0;
		source.cancelWorkers();
		release();
	};
	const pump = (deliver = false) => {
		if (!active || disposed) return false;
		if (isClosed()) { pending.length = 0; active = false; release(); return false; }
		let delivered = false;
		pending.push(...source.takeWorkerUpdates());
		if (pending.length > 0 && (deliver || wake)) {
			const updates = pending.splice(0, MAX_UPDATES_PER_MESSAGE).map(project);
			pi.sendMessage({
				customType: "codeflow:worker_feedback",
				content: JSON.stringify({ updates }),
				display: true,
			}, { triggerTurn: true, deliverAs: wake ? "followUp" : "steer" });
			delivered = true;
			release();
		}
		if (!source.hasLiveWorkers() && pending.length === 0) release();
		if (wake && currentContext?.hasPendingMessages()) release();
		return delivered;
	};
	const tick = () => {
		try { pump(); }
		catch (error) {
			console.error("Codeflow worker feedback failed:", error);
			dispose();
			currentContext?.abort();
		}
	};

	pi.on("agent_start", (_event, ctx) => {
		if (disposed) return;
		currentContext = ctx;
		active = true;
		detachAbort?.();
		const signal = ctx.signal;
		if (signal?.aborted) { dispose(); return; }
		signal?.addEventListener("abort", dispose, { once: true });
		detachAbort = () => signal?.removeEventListener("abort", dispose);
		timer ??= setInterval(tick, FEEDBACK_POLL_MS);
	});
	pi.on("turn_end", (event) => {
		// Do not queue continuations behind an errored provider response. A
		// successful turn boundary safely accepts feedback collected mid-stream.
		if (event.message.role === "assistant"
			&& !["error", "aborted", "length"].includes(event.message.stopReason)) pump(true);
	});

	pi.on("agent_end", async (event, ctx) => {
		const last = event.messages.findLast((message) => message.role === "assistant");
		if (last?.role === "assistant" && ["error", "aborted", "length"].includes(last.stopReason)) {
			active = false;
			// Pi decides retry/compaction only after agent_end. A recoverable Root
			// response must not cancel independently running Children.
			if (last.stopReason === "aborted") dispose();
			return;
		}
		if (disposed || ctx.signal?.aborted || isClosed()) return;
		const delivered = pump(true);
		// Pi's hasPendingMessages() excludes custom sendMessage queues.
		if (delivered || ctx.hasPendingMessages() || !source.hasLiveWorkers()) return;
		// Pi print mode disposes the session when prompt() settles. Keep only the
		// host lifecycle open here, without a provider call or a tool in flight.
		// Any Child can wake this continuation; active Children never wait on it.
		await new Promise<void>((resolve) => {
			wake = resolve;
			pump(); // Scan after arming too, so an exit/update cannot be missed.
			if (disposed || ctx.signal?.aborted || ctx.hasPendingMessages()) release();
		});
	});
	pi.on("session_shutdown", dispose);
}
