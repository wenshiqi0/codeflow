#!/usr/bin/env bun
/** Offline Pi stand-in for Codemark process and cutoff tests. */

import * as fs from "node:fs";
import * as path from "node:path";

function fail(message: string): never {
	console.error(`fake-pi: ${message}`);
	process.exit(70);
}

function body(result: any): any {
	return JSON.parse(result.content[0].text);
}

const argv = process.argv.slice(2);
const extensionPaths: string[] = [];
const systemPrompts: string[] = [];
for (let index = 0; index < argv.length; index += 1) {
	if (argv[index] === "--extension") extensionPaths.push(argv[index + 1] ?? "");
	if (argv[index] === "--append-system-prompt") systemPrompts.push(argv[index + 1] ?? "");
}
const organizationPath = extensionPaths.find((candidate) =>
	candidate.includes("codemark/extensions/organization/index.ts"),
);
const contextPath = extensionPaths.find((candidate) =>
	candidate.includes("codemark/extensions/context/index.ts"),
);
if (!organizationPath) fail("Codemark organization extension was not supplied");
if (!contextPath) fail("Codemark context extension was not supplied");
if (!argv.includes("--no-context-files")) fail("project context files were not disabled");
if (!argv.includes("--no-skills")) fail("skills were not disabled");
if (!argv.includes("--no-session")) fail("session persistence was not disabled");
const promptIndex = argv.indexOf("-p");
if (
	promptIndex < 0
	|| argv[promptIndex + 1] !== "Inspect the Task and organize the work needed to close it."
) {
	fail("Manager did not receive exactly the production fresh-Root instruction");
}
const toolsIndex = argv.indexOf("--tools");
if (toolsIndex < 0 || argv[toolsIndex + 1] !== "read,collaborate") {
	fail("tool allowlist is not read,collaborate");
}
const runtimeDir = process.env.PI_CODING_AGENT_DIR;
if (!runtimeDir) fail("PI_CODING_AGENT_DIR was not supplied");
const productionManagerPrompt = fs.readFileSync(
	path.resolve(runtimeDir, "..", "references", "manager.md"),
	"utf8",
);
if (systemPrompts.length !== 1 || systemPrompts[0] !== productionManagerPrompt) {
	fail("Manager did not receive exactly the production manager.md system prompt");
}
for (const key of [
	"CODEFLOW_RUN_ID",
	"CODEFLOW_GOAL_ID",
	"CODEFLOW_EXECUTION_ID",
	"CODEFLOW_COMMITMENT_ID",
	"CODEFLOW_PROCESS_KIND",
]) {
	if (process.env[key]) fail(`${key} leaked into the Manager measurement`);
}

const contextImported = await import(contextPath);
let beforeAgentStart: ((event: unknown) => any) | undefined;
contextImported.default({
	on(event: string, handler: (event: unknown) => any) {
		if (event === "before_agent_start") beforeAgentStart = handler;
	},
});
if (!beforeAgentStart) fail("Codemark context extension did not register before_agent_start");
const injected = beforeAgentStart({ systemPromptOptions: { cwd: process.cwd() } });
const frontier = JSON.parse(fs.readFileSync(path.join(process.env.CODEMARK_RUN_DIR!, "frontier.json"), "utf8"));
let projectRules = "";
try { projectRules = fs.readFileSync(path.join(process.cwd(), "AGENTS.md"), "utf8"); } catch { /* optional */ }
const productionContext = await import(
	path.join(runtimeDir, "extensions", "codeflow-context", "context.ts")
);
const expectedContext = productionContext.buildFreshRootContext(
	frontier.root_goal.goal_id,
	frontier.root_goal.objective,
	{ projectRules },
);
if (injected.message?.customType !== "codeflow:context") fail("context custom type drifted");
if (injected.message?.content !== expectedContext.xml) fail("fresh Root context content drifted");
if (JSON.stringify(injected.message?.details) !== JSON.stringify({
	sources: expectedContext.sources,
	shape: expectedContext.shape,
})) fail("fresh Root context metadata drifted");

const imported = await import(organizationPath);
let tool: any;
const handlers: Record<string, (...args: any[]) => unknown> = {};
imported.default({
	registerTool(candidate: unknown) { tool = candidate; },
	on(event: string, handler: (...args: any[]) => unknown) { handlers[event] = handler; },
});
if (!tool) fail("organization extension did not register collaborate");

let aborts = 0;
let shutdowns = 0;
const ctx = {
	cwd: process.cwd(),
	abort() { aborts += 1; },
	shutdown() { shutdowns += 1; },
};
const execute = (action: Record<string, unknown>) =>
	tool.execute("fake-call", { action }, undefined, undefined, ctx);

const mode = process.env.CODEMARK_FAKE_PI_MODE ?? "first-turn-end";
let root: { execution_id: string; status: string } | null = null;
if (mode !== "zero-workers") {
	await execute({
		name: "claim",
		work: "record the initial Manager organization frontier",
		done_when: ["the proposed Workers are recorded"],
	});
	root = body(await execute({
		name: "delegate",
		goal_id: process.env.CODEMARK_RUN_ID,
		focus: "inspect the implementation boundary",
	}));
	if (!root || root.status !== "running" || !/^exec_[0-9a-f]{24}$/.test(root.execution_id)) {
		fail("ready root delegation did not match the production running shape");
	}
	const producer = body(await execute({
		name: "delegate",
		new_goal: {
			goal_id: "regression-tests",
			objective: "design focused regression coverage",
		},
		focus: "specify tests independently from the repair",
	}));
	if (producer.status !== "running" || !/^exec_[0-9a-f]{24}$/.test(producer.execution_id)) {
		fail("ready child delegation did not match the production running shape");
	}
	const waiting = body(await execute({
		name: "delegate",
		new_goal: {
			goal_id: "integration",
			objective: "integrate the repair and its regression coverage",
			dependencies: ["regression-tests"],
		},
		focus: "prepare integration after its prerequisite",
	}));
	if (waiting.status !== "waiting" || waiting.execution_id !== null) {
		fail("dependency-blocked delegation did not match the production waiting shape");
	}
}

let usageEmitted = false;
function emitUsage(stopReason: "stop" | "length" | "error" | "aborted" = "stop"): void {
	if (usageEmitted) return;
	usageEmitted = true;
	console.log(JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			provider: "fake-provider",
			model: "fake-manager",
			responseModel: "fake-manager-response",
			timestamp: Date.parse("2026-09-04T00:00:10.000Z"),
			stopReason,
			usage: {
				input: 100,
				output: 20,
				cacheRead: 30,
				cacheWrite: 4,
				reasoning: 5,
				totalTokens: 159,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
			},
		},
	}));
}

async function firstTurnEnd(stopReason: "stop" | "length" | "error" | "aborted" = "stop"): Promise<void> {
	await handlers.agent_end?.({ messages: [{ role: "assistant", stopReason, content: [] }] }, ctx);
	if (aborts !== 0 || shutdowns !== 0) fail("natural turn end must not abort or force shutdown");
}

function keepAlive(): Promise<never> {
	setInterval(() => undefined, 1_000);
	return new Promise<never>(() => undefined);
}

async function waitForReady(stream: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stream.getReader();
	const { value } = await reader.read();
	await reader.cancel();
	if (!value || !new TextDecoder().decode(value).includes("ready")) {
		fail("pipe-holding descendant did not become ready");
	}
}

function exitAfterLateTurnEnd(): void {
	let closing = false;
	process.on("SIGTERM", () => {
		if (closing) return;
		closing = true;
		void (async () => {
			// Keep cutoff-before-turn-end fixtures outside the explicitly turn-end-wins
			// same-millisecond tie used for cross-process ISO timestamps.
			await Bun.sleep(10);
			await firstTurnEnd();
			emitUsage();
			process.exit(0);
		})();
	});
}

if (mode === "environment-precedence") {
	if (process.env.CODEMARK_TEST_DYNAMIC_KEY !== "from-shell") {
		fail("an inherited dynamic provider key did not override the convenience file");
	}
	if (process.env.CODEMARK_TEST_FILE_ONLY !== "from-file") {
		fail("an unset key was not loaded from the convenience file");
	}
}
if (mode === "manager-exit-drain-signal") {
	const codemarkPid = process.ppid;
	const marker = process.env.CODEMARK_FAKE_SIGNAL_MARKER ?? "";
	const pipeHolder = Bun.spawn([
		process.execPath,
		"-e",
		`process.stderr.write("ready\\n"); setTimeout(async () => { await Bun.write(${JSON.stringify(marker)}, "sent"); process.kill(${codemarkPid}, "SIGTERM"); }, 250); setTimeout(() => process.exit(0), 700);`,
	], {
		stdin: "ignore",
		stdout: "inherit",
		stderr: "pipe",
		detached: true,
	});
	pipeHolder.unref();
	await waitForReady(pipeHolder.stderr);
	emitUsage();
} else if (mode === "manager-exit-drain-gap") {
	const pipeHolder = Bun.spawn(["sleep", "1.2"], {
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
	});
	pipeHolder.unref();
	emitUsage();
} else if (mode === "manager-exit-stuck-drain") {
	const pipeHolder = Bun.spawn([
		"bash",
		"-c",
		"trap '' TERM; printf 'ready\\n' >&2; sleep 30",
	], {
		stdin: "ignore",
		stdout: "inherit",
		stderr: "pipe",
	});
	pipeHolder.unref();
	await waitForReady(pipeHolder.stderr);
	emitUsage();
} else if (mode === "manager-exit") {
	emitUsage();
} else if (mode === "length" || mode === "error" || mode === "aborted") {
	emitUsage(mode);
	await firstTurnEnd(mode);
} else if (mode === "turn-end-after-timeout") {
	exitAfterLateTurnEnd();
	await keepAlive();
} else if (mode === "turn-end-after-interrupt") {
	exitAfterLateTurnEnd();
	setTimeout(() => process.kill(process.ppid, "SIGINT"), 50);
	await keepAlive();
} else if (mode === "turn-end-before-timeout") {
	await firstTurnEnd();
	emitUsage();
	process.on("SIGTERM", () => process.exit(0));
	await keepAlive();
} else if (mode === "turn-end-before-interrupt") {
	await firstTurnEnd();
	emitUsage();
	process.on("SIGTERM", () => process.exit(0));
	setTimeout(() => process.kill(process.ppid, "SIGINT"), 50);
	await keepAlive();
} else {
	await firstTurnEnd();
	emitUsage();
}
