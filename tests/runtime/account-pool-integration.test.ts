import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { anthropicCompletion, apiFailure, completion, poolServer, sse } from "../fixtures/account-pool-http";
import { RunPaths } from "../../runtime/lib/paths";
import { readUsageRecords } from "../../runtime/lib/usage";

const repository = path.resolve(import.meta.dir, "../..");
const directories: string[] = [];
const servers: ReturnType<typeof poolServer>[] = [];
const children = new Set<Bun.Subprocess>();

afterEach(async () => {
	for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
	await Promise.all([...children].map(child => child.exited));
	children.clear();
	for (const server of servers.splice(0)) server.stop();
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(respond: Parameters<typeof poolServer>[0], accounts = ["a", "b", "c"], api = "openai-completions") {
	const server = poolServer(respond); servers.push(server);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-pool-http-")); directories.push(dir);
	const piDir = path.join(dir, "pi"); fs.mkdirSync(piDir);
	fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 }, compaction: { enabled: false } }));
	fs.writeFileSync(path.join(piDir, "models.json"), JSON.stringify({ providers: {
		fixture: { api, apiKey: "$SINGLE_API_KEY", baseUrl: api === "anthropic-messages" ? server.url.replace(/\/v1$/, "") : server.url, models: [{ id: "fixed-model", name: "Pool HTTP fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] },
	} }));
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOW_") && !key.startsWith("PI_") && !key.endsWith("_PROXY") && !key.endsWith("_proxy")));
	Object.assign(env, { CODEFLOW_HOME: dir, PI_CODING_AGENT_DIR: piDir, SINGLE_API_KEY: "fixture-key-original", NO_COLOR: "1", CI: "1" });
	for (const account of accounts) env[`POOL_KEY_${account.toUpperCase()}`] = `fixture-key-${account}`;
	function cli(args: string[]) {
		const result = Bun.spawnSync(["bash", path.join(repository, "runtime/bin/codeflow"), "accounts", ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(`accounts CLI failed: ${result.stderr.toString()}`);
		return JSON.parse(result.stdout.toString());
	}
	for (const account of accounts) cli(["add", "fixture/fixed-model", account, "--key-env", `POOL_KEY_${account.toUpperCase()}`]);
	async function run(tools = false) {
		const child = Bun.spawn([process.execPath, path.join(repository, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
			"--mode", "json", "--provider", "fixture", "--model", "fixed-model", "--no-extensions",
			"--extension", path.join(repository, "runtime/extensions/account-pool/index.ts"),
			"--extension", path.join(repository, "runtime/extensions/usage-ledger/index.ts"),
			"--extension", path.join(repository, "runtime/extensions/telemetry-ledger/index.ts"),
			"--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session",
			...(tools ? ["--tools", "bash"] : ["--no-tools"]), "-p", "Run the fixture request."],
			{ cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		children.add(child);
		const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			if (child.signalCode === "SIGKILL") throw new Error("Pi account pool request exceeded its bounded fixture deadline");
			expect(stderr).not.toMatch(/Extension error|Failed to load extension/);
			const events = stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
			return { stdout, stderr, exitCode, events, messages: events.filter(event => event.type === "message_end" && event.message?.role === "assistant").map(event => event.message) };
		} finally { clearTimeout(timer); }
	}
	return { server, dir, env, cli, run };
}

describe("account pool through real Pi and local HTTP", () => {
	test("invalid pool configuration prevents a request using the old single key", async () => {
		const f = fixture(() => completion());
		fs.writeFileSync(path.join(f.dir, "account-pools.json"), "{bad-config fixture-key-a");
		const result = await f.run();
		expect(result.exitCode).toBe(1);
		expect(f.server.requests).toEqual([]);
		expect(result.stdout + result.stderr).not.toContain("fixture-key-a");
	}, 20000);

	test("discarded attempts retain reported usage in normal and benchmark ledgers", async () => {
		const f = fixture(request => request.account === "a" ? sse([
			{ choices: [{ index: 0, delta: { role: "assistant", content: "PRIVATE_PARTIAL" }, finish_reason: null }], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } },
			{ error: { message: "service temporarily unavailable", type: "server_error" } },
		]) : completion());
		f.env.CODEFLOW_RUN_ID = "task-pool-usage";
		f.env.CODEFLOW_RUNS_DIR = path.join(f.dir, "runs");
		f.env.CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR = path.join(f.dir, "benchmark-ledger");
		expect((await f.run()).messages.at(-1)?.stopReason).toBe("stop");
		const records = readUsageRecords(new RunPaths(f.env.CODEFLOW_RUNS_DIR, f.env.CODEFLOW_RUN_ID));
		expect(records.map(row => row.usage.input)).toEqual([11, 10]);
		expect(records.map(row => row.usage.total_tokens)).toEqual([13, 13]);
		const benchmark = fs.readFileSync(path.join(f.env.CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR, "usage.jsonl"), "utf8");
		expect(benchmark.trim().split("\n").map(line => JSON.parse(line).usage.input)).toEqual([11, 10]);
		expect(JSON.stringify(records) + benchmark).not.toMatch(/PRIVATE_PARTIAL|fixture-key-/);
	}, 20000);

	test("Anthropic Messages rotates the x-api-key header and retains the replacement", async () => {
		const f = fixture(request => request.account === "a" ? apiFailure(401, "authentication failed", "authentication_error") : anthropicCompletion(), ["a", "b"], "anthropic-messages");
		for (let index = 0; index < 2; index++) expect((await f.run()).messages.at(-1)?.stopReason).toBe("stop");
		expect(f.server.requests.map(row => row.account)).toEqual(["a", "b", "b"]);
	}, 20000);

	test("a stalled HTTP request moves to the next account", async () => {
		const f = fixture(async request => {
			if (request.account === "a") { await Bun.sleep(500); return completion(); }
			return completion();
		});
		f.env.CODEFLOW_ACCOUNT_POOL_TIMEOUT_MS = "100";
		expect((await f.run()).messages.at(-1)?.stopReason).toBe("stop");
		expect(f.server.requests.map(row => row.account)).toEqual(["a", "b"]);
	}, 20000);

	test("unconfigured models retain their original single key", async () => {
		const f = fixture(() => completion(), []);
		const result = await f.run();
		expect(result.messages.at(-1)?.stopReason).toBe("stop");
		expect(f.server.requests.map(row => row.account)).toEqual(["original"]);
	}, 20000);

	test("pool credentials work when the original single key is absent", async () => {
		const f = fixture(() => completion());
		delete f.env.SINGLE_API_KEY;
		const result = await f.run();
		expect(result.messages.at(-1)?.stopReason).toBe("stop");
		expect(f.server.requests.map(row => row.account)).toEqual(["a"]);
	}, 20000);

	test("simultaneous failures of the old account do not skip the shared replacement", async () => {
		let release!: () => void;
		const overlap = new Promise<void>(resolve => { release = resolve; });
		let failures = 0;
		const f = fixture(async request => {
			if (request.account === "a") {
				if (++failures === 2) release();
				await overlap;
				return apiFailure(401, "invalid API key", "authentication_error");
			}
			return completion();
		});
		const results = await Promise.all([f.run(), f.run()]);
		for (const result of results) expect(result.messages.at(-1)?.stopReason).toBe("stop");
		await f.run();
		expect(f.server.requests.map(row => row.account)).toEqual(["a", "a", "b", "b", "b"]);
	}, 20000);

	test("keeps the fixed model and shares the replacement account with the next Pi process", async () => {
		let failB = false;
		const f = fixture(request => request.account === "a" || (failB && request.account === "b") ? apiFailure(429, "rate limit exceeded") : completion());
		for (let index = 0; index < 2; index++) {
			const result = await f.run();
			expect(result.exitCode).toBe(0);
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].stopReason).toBe("stop");
		}
		expect(f.server.requests.map(row => row.account)).toEqual(["a", "b", "b"]);
		failB = true;
		expect((await f.run()).messages[0].stopReason).toBe("stop");
		expect((await f.run()).messages[0].stopReason).toBe("stop");
		expect(f.server.requests.map(row => row.account)).toEqual(["a", "b", "b", "b", "c", "c"]);
		expect(new Set(f.server.requests.map(row => row.body.model))).toEqual(new Set(["fixed-model"]));
	}, 30000);

	test("exhausts each account once even when Pi automatic retries are enabled", async () => {
		const f = fixture(request => apiFailure(503, `fixture-key-${request.account}: service temporarily unavailable`));
		const result = await f.run();
		expect(result.messages.at(-1)?.stopReason).toBe("error");
		expect(f.server.requests.map(row => row.account)).toEqual(["a", "b", "c"]);
		expect(result.stdout + result.stderr + JSON.stringify(f.cli(["list"]))).not.toContain("fixture-key-");
	}, 20000);

		test("reports parameter errors without trying the next account", async () => {
		const f = fixture(() => apiFailure(400, "unsupported parameter temperature", "invalid_request_error"));
		const result = await f.run();
		expect(result.messages.at(-1)?.stopReason).toBe("error");
		expect(result.messages.at(-1)?.diagnostics[0].error.message).toContain("unsupported parameter temperature");
		expect(f.server.requests.map(row => row.account)).toEqual(["a"]);
	}, 20000);

	test("manual selection is sticky", async () => {
		const f = fixture(() => completion());
		f.cli(["use", "fixture/fixed-model", "c"]);
		await f.run(); await f.run();
		expect(f.server.requests.map(row => row.account)).toEqual(["c", "c"]);
	}, 20000);

	test("a failed streamed tool call is never executed or replayed into the replacement request", async () => {
		let command = "";
		const f = fixture(request => {
			if (request.account === "a") return sse([
				{ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "failed-tool", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }, finish_reason: null }] },
				{ error: { message: "service temporarily unavailable", type: "server_error", code: "503" } },
			]);
			if (request.body.messages.some(message => message.role === "tool")) return completion();
			return completion("", { id: "successful-tool", command });
		});
		command = "echo ran >> tool-count.txt";
		const result = await f.run(true);
		expect(result.messages.at(-1)?.stopReason).toBe("stop");
		expect(fs.readFileSync(path.join(f.dir, "tool-count.txt"), "utf8")).toBe("ran\n");
		expect(f.server.requests.map(row => row.account)).toEqual(["a", "b", "b"]);
		expect(JSON.stringify(f.server.requests[1].body.messages)).not.toContain("failed-tool");
	}, 20000);
});
