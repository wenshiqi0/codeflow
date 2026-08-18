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

test("CODEFLOW_STREAM_IDLE_TIMEOUT_MS=0 disables the stream-idle abort", async () => {
	// 0 is the documented escape hatch: the abort line itself tells operators
	// to "set CODEFLOW_STREAM_IDLE_TIMEOUT_MS=0 to disable". A default change
	// must not silently remove that kill switch — pin the behavior, not just
	// the parse. This test runs first in the file so no sibling module
	// instance's interval is armed yet: with the guard removed, a mis-wired
	// interval at the 30ms tick would fire several times within 400ms, so
	// never-aborted and zero marker lines here prove it was never armed.
	const savedTimeout = process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS;
	const savedTick = process.env.CODEFLOW_STREAM_IDLE_TICK_MS;
	process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS = "0";
	process.env.CODEFLOW_STREAM_IDLE_TICK_MS = "30";
	const originalWrite = process.stderr.write;
	const lines: string[] = [];
	try {
		const mod = await import("../../runtime/extensions/agent-watchdog/index.ts?disabled");
		const gate = await import("../../runtime/extensions/codeflow-task/handoff-gate.ts");
		// biome-ignore lint/suspicious/noExplicitAny: the marker export is the contract under test
		const marker = (gate as any).STREAM_IDLE_ABORT_MARKER;

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

		process.stderr.write = ((chunk: unknown) => {
			lines.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		handlers.before_provider_request?.({}, stubCtx);
		// ~13 ticks at 30ms: a mis-wired interval would have fired repeatedly.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(aborted).toBe(0);
		expect(lines.some((line) => line.includes(marker))).toBe(false);
	} finally {
		process.stderr.write = originalWrite;
		if (savedTimeout === undefined) delete process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS;
		else process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS = savedTimeout;
		if (savedTick === undefined) delete process.env.CODEFLOW_STREAM_IDLE_TICK_MS;
		else process.env.CODEFLOW_STREAM_IDLE_TICK_MS = savedTick;
	}
});


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

test("the stream-idle default is 900000ms, not 300000ms", async () => {
	// A 5-minute default kills normal long reasoning pauses: the repo's own
	// staleness bound (DEFAULT_STALE_SECONDS, 600s) documents ten minutes of
	// silent reasoning as unremarkable, so the default must be those 600s
	// plus the previous 300s of patience. Assert the constant — never wait
	// out fifteen minutes to observe it. The module reads env at import, so
	// the cache-busting query re-reads it with the variable deleted.
	const saved = process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS;
	delete process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS;
	try {
		const mod = await import("../../runtime/extensions/agent-watchdog/index.ts?defaults");
		// biome-ignore lint/suspicious/noExplicitAny: probing the module's exported constants
		expect((mod as any).STREAM_IDLE_DEFAULT_MS).toBe(900000);
		// biome-ignore lint/suspicious/noExplicitAny: probing the module's exported constants
		expect((mod as any).STREAM_IDLE_TIMEOUT_MS).toBe(900000);
	} finally {
		if (saved === undefined) delete process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS;
		else process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS = saved;
	}
});

test("CODEFLOW_STREAM_IDLE_TIMEOUT_MS still overrides the raised default", async () => {
	// The env knob — including 0 = disabled — is the operator's escape hatch;
	// raising the default must not swallow it. Pin the parsed value, not just
	// the behavior.
	const saved = process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS;
	process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS = "42000";
	try {
		const mod = await import("../../runtime/extensions/agent-watchdog/index.ts?override");
		// biome-ignore lint/suspicious/noExplicitAny: probing the module's exported constants
		expect((mod as any).STREAM_IDLE_TIMEOUT_MS).toBe(42000);
	} finally {
		if (saved === undefined) delete process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS;
		else process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS = saved;
	}
});

test("aborts a bash tool that exceeds its hard wall-time limit", async () => {
	const savedTimeout = process.env.CODEFLOW_BASH_TIMEOUT_MS;
	process.env.CODEFLOW_BASH_TIMEOUT_MS = "120";
	const originalWrite = process.stderr.write;
	const lines: string[] = [];
	try {
		const mod = await import("../../runtime/extensions/agent-watchdog/index.ts?bash-timeout");
		const handlers: Record<string, (e: any, ctx: any) => void> = {};
		const stubPi = {
			on: (event: string, handler: (e: any, ctx: any) => void) => {
				handlers[event] = handler;
			},
		};
		let aborted = 0;
		const stubCtx = { abort: () => { aborted++; } };
		(mod as any).default(stubPi);

		process.stderr.write = ((chunk: unknown) => {
			lines.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		handlers.tool_execution_start?.(
			{ toolCallId: "bash-stuck", toolName: "bash", args: {} },
			stubCtx,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(aborted).toBe(1);
		expect(lines.some((line) => line.includes((mod as any).BASH_TIMEOUT_ABORT_MARKER))).toBe(true);
	} finally {
		process.stderr.write = originalWrite;
		if (savedTimeout === undefined) delete process.env.CODEFLOW_BASH_TIMEOUT_MS;
		else process.env.CODEFLOW_BASH_TIMEOUT_MS = savedTimeout;
	}
});

test("clears a bash hard-timeout when the tool finishes", async () => {
	const savedTimeout = process.env.CODEFLOW_BASH_TIMEOUT_MS;
	process.env.CODEFLOW_BASH_TIMEOUT_MS = "120";
	try {
		const mod = await import("../../runtime/extensions/agent-watchdog/index.ts?bash-finished");
		const handlers: Record<string, (e: any, ctx: any) => void> = {};
		const stubPi = {
			on: (event: string, handler: (e: any, ctx: any) => void) => {
				handlers[event] = handler;
			},
		};
		let aborted = 0;
		const stubCtx = { abort: () => { aborted++; } };
		(mod as any).default(stubPi);

		const event = { toolCallId: "bash-fast", toolName: "bash", args: {} };
		handlers.tool_execution_start?.(event, stubCtx);
		handlers.tool_execution_end?.(event, stubCtx);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(aborted).toBe(0);
	} finally {
		if (savedTimeout === undefined) delete process.env.CODEFLOW_BASH_TIMEOUT_MS;
		else process.env.CODEFLOW_BASH_TIMEOUT_MS = savedTimeout;
	}
});

test("CODEFLOW_BASH_TIMEOUT_MS=0 disables the bash hard-timeout", async () => {
	const savedTimeout = process.env.CODEFLOW_BASH_TIMEOUT_MS;
	process.env.CODEFLOW_BASH_TIMEOUT_MS = "0";
	try {
		const mod = await import("../../runtime/extensions/agent-watchdog/index.ts?bash-disabled");
		const handlers: Record<string, (e: any, ctx: any) => void> = {};
		const stubPi = {
			on: (event: string, handler: (e: any, ctx: any) => void) => {
				handlers[event] = handler;
			},
		};
		let aborted = 0;
		const stubCtx = { abort: () => { aborted++; } };
		(mod as any).default(stubPi);
		handlers.tool_execution_start?.(
			{ toolCallId: "bash-disabled", toolName: "bash", args: {} },
			stubCtx,
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(aborted).toBe(0);
	} finally {
		if (savedTimeout === undefined) delete process.env.CODEFLOW_BASH_TIMEOUT_MS;
		else process.env.CODEFLOW_BASH_TIMEOUT_MS = savedTimeout;
	}
});

test("the abort line carries the shared STREAM_IDLE_ABORT_MARKER", async () => {
	// handoff-gate classifies a watchdog abort by matching the abort line's
	// prefix. The marker constant lives in handoff-gate as the single
	// contract and the watchdog must write it, so producer and consumer
	// cannot drift apart. Capture stderr during the same TTFT-stall pattern
	// as the behavioral test above and assert the emitted line contains it.
	const savedTimeout = process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS;
	const savedTick = process.env.CODEFLOW_STREAM_IDLE_TICK_MS;
	process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS = "120";
	process.env.CODEFLOW_STREAM_IDLE_TICK_MS = "30";
	const originalWrite = process.stderr.write;
	const lines: string[] = [];
	try {
		const mod = await import("../../runtime/extensions/agent-watchdog/index.ts?marker");
		const gate = await import("../../runtime/extensions/codeflow-task/handoff-gate.ts");
		// biome-ignore lint/suspicious/noExplicitAny: the marker export is the contract under test
		const marker = (gate as any).STREAM_IDLE_ABORT_MARKER;
		expect(typeof marker).toBe("string");
		expect(marker.length).toBeGreaterThan(0);

		const handlers: Record<string, (e: unknown, ctx: unknown) => void> = {};
		const stubPi = {
			on: (event: string, handler: (e: unknown, ctx: unknown) => void) => {
				handlers[event] = handler;
			},
		};
		const stubCtx = { abort: () => {} };

		// biome-ignore lint/suspicious/noExplicitAny: stub for the extension API
		(mod as any).default(stubPi);

		process.stderr.write = ((chunk: unknown) => {
			lines.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		handlers.before_provider_request?.({}, stubCtx);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(lines.some((line) => line.includes(marker))).toBe(true);
	} finally {
		process.stderr.write = originalWrite;
		if (savedTimeout === undefined) delete process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS;
		else process.env.CODEFLOW_STREAM_IDLE_TIMEOUT_MS = savedTimeout;
		if (savedTick === undefined) delete process.env.CODEFLOW_STREAM_IDLE_TICK_MS;
		else process.env.CODEFLOW_STREAM_IDLE_TICK_MS = savedTick;
	}
});
