import { test, expect } from "bun:test";

/**
 * Behavioral proof that the stream-idle watchdog actually fires.
 *
 * The contract test in tests/runtime/extensions/ asserts the wiring exists;
 * this one drives the real module with a stub pi/ctx and a tiny timeout and
 * proves `ctx.abort()` is called when a provider request stalls — including
 * the TTFT case (request sent, no `message_update` ever) that an earlier
 * isIdle()-gated version silently skipped for 10+ minutes.
 *
 * The module reads CODEFLOW_STREAM_IDLE_* at load, so env is set before the
 * dynamic import. `import type` in index.ts is erased at runtime, so no pi
 * package resolution is needed here.
 */

test("aborts a stalled provider request at TTFT (no message_update)", async () => {
	process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS = "120";
	process.env.CODEFLOW_STREAM_IDLE_TICK_MS = "30";
	const mod = await import("../../runtime/extensions/agent-watchdog/index.ts");

	const handlers: Record<string, (e: unknown, ctx: unknown) => void> = {};
	const stubPi = {
		on: (event: string, handler: (e: unknown, ctx: unknown) => void) => {
			handlers[event] = handler;
		},
	};
	let aborted = 0;
	const stubCtx = { abort: () => { aborted++; } };

	// biome-ignore lint/suspicious/noExplicitAny: stub for the extension API
	(mod as any).default(stubPi);

	// Provider request opens the in-flight window + stamps progress...
	handlers.before_provider_request?.({}, stubCtx);
	// ...then nothing arrives (TTFT stall). After the timeout the watchdog
	// must abort via ctx.abort().
	await new Promise((resolve) => setTimeout(resolve, 400));
	expect(aborted).toBeGreaterThan(0);
});

test("does not abort while real streaming tokens keep arriving", async () => {
	process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS = "120";
	process.env.CODEFLOW_STREAM_IDLE_TICK_MS = "30";
	const mod = await import("../../runtime/extensions/agent-watchdog/index.ts?live");

	const handlers: Record<string, (e: unknown, ctx: unknown) => void> = {};
	const stubPi = {
		on: (event: string, handler: (e: unknown, ctx: unknown) => void) => {
			handlers[event] = handler;
		},
	};
	let aborted = 0;
	const stubCtx = { abort: () => { aborted++; } };

	// biome-ignore lint/suspicious/noExplicitAny: stub for the extension API
	(mod as any).default(stubPi);

	handlers.before_provider_request?.({}, stubCtx);
	// Keep delivering message_update tokens faster than the timeout window.
	for (let i = 0; i < 4; i++) {
		await new Promise((resolve) => setTimeout(resolve, 60));
		handlers.message_update?.({}, stubCtx);
	}
	expect(aborted).toBe(0);
});
