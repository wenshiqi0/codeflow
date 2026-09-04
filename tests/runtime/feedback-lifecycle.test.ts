import { afterEach, describe, expect, test } from "bun:test";
import { registerWorkerFeedback, FEEDBACK_POLL_MS } from "../../runtime/extensions/codeflow-organization/feedback";
import { type WorkerFeedback } from "../../runtime/extensions/codeflow-organization/worker-launcher";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const item of fixtures.splice(0)) item.emit("session_shutdown"); });

function fixture() {
	const handlers = new Map<string, Function>();
	const messages: { content: string; options: any }[] = [];
	const source: WorkerFeedback[] = [];
	let live = true;
	let terminal = false;
	let queued = false;
	let cancellations = 0;
	const controller = new AbortController();
	const context = {
		signal: controller.signal,
		hasPendingMessages: () => queued,
		abort: () => controller.abort(),
	};
	registerWorkerFeedback({
		on: (name: string, callback: Function) => handlers.set(name, callback),
		sendMessage: (message: any, options: any) => {
			messages.push({ content: message.content, options });
		},
	} as never, {
		takeWorkerUpdates: () => source.splice(0),
		hasLiveWorkers: () => live,
		rootClosed: () => terminal,
		cancelWorkers: () => { cancellations++; },
	});
	const item = {
		messages, source, controller, context,
		get cancellations() { return cancellations; },
		set live(value: boolean) { live = value; },
		set terminal(value: boolean) { terminal = value; },
		set queued(value: boolean) { queued = value; },
		emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event, context),
	};
	fixtures.push(item);
	item.emit("agent_start");
	return item;
}

const update = (id = "receipt-test"): WorkerFeedback => ({
	execution_id: "exec-tester", goal_id: "task-feedback", commitment_id: "commit-tester",
	receipt_id: id, status: "progress",
});
const end = (stopReason = "stop") => ({ messages: [{ role: "assistant", stopReason }] });
const turn = (stopReason = "stop") => ({ message: { role: "assistant", stopReason } });

describe("event-driven Root lifecycle", () => {
	test("an idle Root stays alive without model calls and tester progress resumes it before development ends", async () => {
		const item = fixture();
		let released = false;
		const parked = item.emit("agent_end", end()).then(() => { released = true; });
		await Bun.sleep(FEEDBACK_POLL_MS + 30);
		expect(released).toBe(false);
		expect(item.messages).toHaveLength(0);
		item.source.push(update());
		await parked;
		expect(item.messages).toHaveLength(1);
		expect(item.messages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(JSON.parse(item.messages[0].content).updates[0].receipt_id).toBe("receipt-test");
		expect(item.cancellations).toBe(0);
	});

	test("feedback collected during generation is delivered at a successful turn boundary", async () => {
		const item = fixture();
		item.source.push(update());
		await Bun.sleep(FEEDBACK_POLL_MS + 30);
		expect(item.messages).toHaveLength(0);
		item.emit("turn_end", turn());
		expect(item.messages).toHaveLength(1);
		expect(item.messages[0].options.deliverAs).toBe("steer");
		item.emit("turn_end", turn());
		expect(item.messages).toHaveLength(1);
	});

	test("an agent_end custom message resumes immediately even when Pi reports no pending user messages", async () => {
		const item = fixture();
		item.source.push(update());
		await item.emit("agent_end", end());
		expect(item.context.hasPendingMessages()).toBe(false);
		expect(item.messages).toHaveLength(1);
	});

	test.each(["error", "aborted", "length"])("%s cannot turn buffered feedback into another model call", async (reason) => {
		const item = fixture();
		item.source.push(update());
		await Bun.sleep(FEEDBACK_POLL_MS + 30);
		item.emit("turn_end", turn(reason));
		await item.emit("agent_end", end(reason));
		expect(item.messages).toHaveLength(0);
		expect(item.cancellations).toBe(reason === "aborted" ? 1 : 0);
	});

	test("a recoverable Root failure preserves Children and buffered feedback across retry", async () => {
		const item = fixture();
		item.source.push(update());
		await item.emit("agent_end", end("error"));
		expect(item.cancellations).toBe(0);
		item.emit("agent_start");
		item.emit("turn_end", turn());
		expect(item.messages).toHaveLength(1);
		expect(item.cancellations).toBe(0);
	});

	test("new user input also releases an idle Root without waiting for Worker progress", async () => {
		const item = fixture();
		const parked = item.emit("agent_end", end());
		item.queued = true;
		await parked;
		expect(item.messages).toHaveLength(0);
		expect(item.cancellations).toBe(0);
	});

	test("queued messages bypass parking and a missing terminal Receipt is not fabricated", async () => {
		const item = fixture();
		item.queued = true;
		await item.emit("agent_end", end());
		item.queued = false;
		item.live = false;
		await item.emit("agent_end", end());
		expect(item.messages).toHaveLength(0);
	});

	test("idle cancellation unblocks print mode and cancels Children without a continuation", async () => {
		const item = fixture();
		const parked = item.emit("agent_end", end());
		item.controller.abort();
		await parked;
		item.source.push(update());
		await Bun.sleep(FEEDBACK_POLL_MS + 30);
		expect(item.messages).toHaveLength(0);
		expect(item.cancellations).toBe(1);
	});

	test("a fast final exit is drained before Root exits and closure suppresses late delivery", async () => {
		const item = fixture();
		item.source.push(update());
		item.live = false;
		await item.emit("agent_end", end());
		expect(item.messages).toHaveLength(1);
		item.terminal = true;
		item.source.push(update("late"));
		item.emit("turn_end", turn());
		expect(item.messages).toHaveLength(1);
	});

	test("large feedback bursts are bounded without dropping records", async () => {
		const item = fixture();
		item.source.push(...Array.from({ length: 65 }, (_, i) => update(`r-${i}`)));
		for (let i = 0; i < 3; i++) item.emit("turn_end", turn());
		const batches = item.messages.map((message) => JSON.parse(message.content).updates);
		expect(batches.map((batch) => batch.length)).toEqual([32, 32, 1]);
		expect(new Set(batches.flat().map((value) => value.receipt_id)).size).toBe(65);
	});

	test("pre-claim blockers retain bounded reasons without leaking arbitrary execution fields", () => {
		const item = fixture();
		item.source.push({
			execution_id: "exec-blocked", goal_id: "task-feedback", commitment_id: null,
			receipt_id: null, status: "reported", exit_code: 0, stop_reason: "stop",
			runtime_failure_reasons: [], retryable: false,
			report: { summary: "need a different boundary", remaining: ["clarify outcome"] },
		} as WorkerFeedback);
		item.emit("turn_end", turn());
		const feedback = JSON.parse(item.messages[0].content).updates[0];
		expect(feedback.report).toEqual({ summary: "need a different boundary", remaining: ["clarify outcome"] });
		expect(feedback).not.toHaveProperty("stop_reason");
	});
});
