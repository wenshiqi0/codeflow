import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { currentPoolSelection, type AccountPool } from "../../runtime/lib/account-pool";
import { classifyPoolFailure, pooledStream, type PoolFailure } from "../../runtime/lib/account-pool-stream";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const pool: AccountPool = { model: "pool-test/fixed", accounts: [{ id: "a", apiKeyEnv: "KEY_A" }, { id: "b", apiKeyEnv: "KEY_B" }] };
function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-pool-stream-")); directories.push(dir);
	const env = { CODEFLOW_HOME: dir, KEY_A: "synthetic-a", KEY_B: "synthetic-b" };
	fs.writeFileSync(path.join(dir, "account-pools.json"), JSON.stringify({ schema_version: 1, pools: [pool] }));
	const provider = fauxProvider({ provider: "pool-test", models: [{ id: "fixed" }] });
	return { env, provider, model: provider.getModel() };
}

describe("account request failure boundary", () => {
	test.each([
		[401, "unauthorized", "authentication"], [403, "forbidden", "authentication"],
		[402, "payment required", "balance"], [429, "limited", "throttled"], [408, "request expired", "deadline"],
		[500, "oops", "service"], [503, "offline", "service"], [400, "insufficient_quota", "balance"],
		[400, "unsupported parameter", "rejected"], [422, "invalid temperature", "rejected"],
		[undefined, "connection error", "transport"], [undefined, "request timed out", "deadline"],
		[undefined, "余额不足", "balance"], [undefined, "invalid API key", "authentication"],
		[200, "service temporarily unavailable", "service"],
		[400, "maximum context length exceeded", "rejected"], [undefined, "unknown parser failure", "rejected"],
	] as Array<[number | undefined, string, PoolFailure]>)("classifies status=%s, error=%s as %s", (status, error, category) => {
		expect(classifyPoolFailure(fauxAssistantMessage([], { stopReason: "error", errorMessage: error }), status)).toBe(category);
	});

	test("cancellation does not call a provider or change account selection", async () => {
		const f = setup();
		const controller = new AbortController(); controller.abort();
		const stream = pooledStream(pool, f.provider.provider.streamSimple, f.env)(f.model, { messages: [] }, { signal: controller.signal });
		expect((await stream.result()).stopReason).toBe("aborted");
		expect(f.provider.state.callCount).toBe(0);
		expect(currentPoolSelection(pool, f.env).account_id).toBe("a");
	});

	test("SDK retries are disabled and a missing key is skipped without contacting the provider", async () => {
		const f = setup();
		const env = { ...f.env, KEY_A: undefined };
		const options: SimpleStreamOptions[] = [];
		f.provider.setResponses([(_context, option) => { options.push(option!); return fauxAssistantMessage("ok"); }]);
		const stream = pooledStream(pool, f.provider.provider.streamSimple, env)(f.model, { messages: [] }, { maxRetries: 5, headers: { Authorization: "stale", "x-api-key": "stale", "X-Keep": "yes" } });
		expect((await stream.result()).stopReason).toBe("stop");
		expect(options[0].apiKey).toBe("synthetic-b");
		expect(options[0].maxRetries).toBe(0);
		expect(options[0].headers).toEqual({ "X-Keep": "yes" });
	});

	test("a per-account idle deadline switches credentials without cancelling the whole request", async () => {
		const f = setup();
		const attempted: string[] = [];
		const underlying = (model: typeof f.model, _context: unknown, options?: SimpleStreamOptions) => {
			attempted.push(options!.apiKey!);
			const stream = createAssistantMessageEventStream();
			if (options?.apiKey === "synthetic-a") options.signal?.addEventListener("abort", () => {
				stream.push({ type: "error", reason: "aborted", error: fauxAssistantMessage([], { stopReason: "aborted" }) }); stream.end();
			}, { once: true });
			else { stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("ok") }); stream.end(); }
			return stream;
		};
		const result = await pooledStream(pool, underlying, { ...f.env, CODEFLOW_ACCOUNT_POOL_TIMEOUT_MS: "25" })(f.model, { messages: [] }).result();
		expect(result.stopReason).toBe("stop");
		expect(attempted).toEqual(["synthetic-a", "synthetic-b"]);
		expect(currentPoolSelection(pool, f.env).account_id).toBe("b");
	});

	test("failed partial messages never appear in the outer event stream", async () => {
		const f = setup();
		f.provider.setResponses([
			fauxAssistantMessage("PRIVATE_FAILED_PARTIAL", { stopReason: "error", errorMessage: "service unavailable synthetic-a" }),
			fauxAssistantMessage("success"),
		]);
		const stream = pooledStream(pool, f.provider.provider.streamSimple, f.env)(f.model, { messages: [] });
		const events = []; for await (const event of stream) events.push(event);
		expect(JSON.stringify(events)).not.toMatch(/PRIVATE_FAILED_PARTIAL|synthetic-a/);
		expect(events.map(event => event.type)).toEqual(["done"]);
	});

	test("provider diagnostics redact both padded and trimmed credential values", async () => {
		const f = setup();
		f.provider.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "bad parameter synthetic-a" })]);
		const result = await pooledStream(pool, f.provider.provider.streamSimple, { ...f.env, KEY_A: " synthetic-a " })(f.model, { messages: [] }).result();
		expect(result.errorMessage).toBe("ACCOUNT_POOL_REQUEST_REJECTED");
		expect(result.diagnostics?.[0].error?.message).toBe("bad parameter [redacted]");
	});
});
