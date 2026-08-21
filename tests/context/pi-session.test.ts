import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repo = path.resolve(import.meta.dir, "../..");
const pi = path.join(repo, "runtime/bin/pi");
const piCli = path.join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const providerExtension = path.join(import.meta.dir, "fixtures/pi-smoke-provider.ts");
const contextExtension = path.join(repo, "runtime/extensions/codeflow-context/index.ts");

const temporaryRoots: string[] = [];

interface ContextMessage {
	content: string;
	details: {
		mode: "full" | "delta" | "fallback";
		facts: { fromCursor: number; toCursor: number };
		fallbackReason?: string;
	};
}

function temporaryRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
}

function environment(runsDir: string): Record<string, string> {
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	for (const key of [
		"CODEFLOW_AGENT_ROLE",
		"CODEFLOW_AGENT_DEPTH",
		"CODEFLOW_CONTEXT_DELTA",
		"CODEFLOW_HANDOFF_ID",
		"CODEFLOW_RUN_ID",
		"CODEFLOW_RUNS_DIR",
	]) {
		delete env[key];
	}
	return {
		...env,
		CODEFLOW_PI_CLI: piCli,
		CODEFLOW_AGENT_ROLE: "coder",
		CODEFLOW_RUN_ID: "run-pi-context-smoke",
		CODEFLOW_RUNS_DIR: runsDir,
		PI_CODING_AGENT_DIR: path.join(repo, "runtime"),
	};
}

function runPi(root: string, prompt: string): { stdout: string; stderr: string } {
	const result = Bun.spawnSync(
		[
			"bash",
			pi,
			"--mode",
			"json",
			"--provider",
			"pi-session-smoke",
			"--model",
			"smoke-model",
			"--system-prompt",
			"Pi session context smoke",
			"--no-extensions",
			"--extension",
			providerExtension,
			"--extension",
			contextExtension,
			"--no-context-files",
			"--no-tools",
			"--offline",
			"--session-id",
			"context-smoke",
			"--session-dir",
			path.join(root, "sessions"),
			"-p",
			prompt,
		],
		{
			cwd: root,
			env: environment(path.join(root, "runs")),
			timeout: 30_000,
		},
	);
	expect(result.exitCode).toBe(0);
	return {
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function contextFromStdout(stdout: string): ContextMessage {
	const messages: ContextMessage[] = [];
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const message = event.type === "message_end" ? event.message : undefined;
		if (message?.role === "custom" && message.customType === "codeflow:context") {
			messages.push(message as ContextMessage);
		}
	}
	expect(messages).toHaveLength(1);
	return messages[0];
}

function sessionFile(root: string): string {
	const sessionDir = path.join(root, "sessions");
	const files = fs.readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
	expect(files).toHaveLength(1);
	return path.join(sessionDir, files[0]);
}

function persistedContexts(root: string): ContextMessage[] {
	const contexts: ContextMessage[] = [];
	for (const line of fs.readFileSync(sessionFile(root), "utf-8").split("\n")) {
		if (line.trim() === "") continue;
		const entry = JSON.parse(line) as Partial<ContextMessage> & { customType?: string };
		if (entry.customType === "codeflow:context") contexts.push(entry as ContextMessage);
	}
	return contexts;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("real Pi persistent-session context continuation", () => {
	test("a second real Pi process emits a delta from the persisted context message", () => {
		const root = temporaryRoot("codeflow-pi-context-smoke-");
		const runDir = path.join(root, "runs", "run-pi-context-smoke");
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(
			path.join(runDir, "facts.jsonl"),
			JSON.stringify({
				id: "f1",
				kind: "fact",
				role: "tester",
				handoff_id: "h1",
				claim: "first smoke fact",
				value: "one",
			}) + "\n",
			"utf-8",
		);

		const first = contextFromStdout(runPi(root, "first smoke handoff").stdout);
		expect(first.details.mode).toBe("full");
		expect(first.details.facts).toEqual({ fromCursor: 0, toCursor: 1 });
		expect(first.content).toContain("<shared_rules>");
		expect(first.content).toContain("f1: first smoke fact — one [tester]");
		expect(first.content).not.toContain("generated_at");

		fs.appendFileSync(
			path.join(runDir, "facts.jsonl"),
			JSON.stringify({
				id: "f2",
				kind: "supersede",
				role: "coder",
				handoff_id: "h2",
				claim: "second smoke fact",
				value: "two",
				supersedes: "f1",
				reason: "corrected",
			}) + "\n",
			"utf-8",
		);

		const second = contextFromStdout(runPi(root, "second smoke handoff").stdout);
		expect(second.details.mode).toBe("delta");
		expect(second.details.fallbackReason).toBeUndefined();
		expect(second.details.facts).toEqual({ fromCursor: 1, toCursor: 2 });
		expect(second.content).not.toContain("<shared_rules>");
		expect(second.content).toContain('action="unchanged"');
		expect(second.content).toContain("<shared_facts_delta>");
		expect(second.content).toContain("f2: second smoke fact — two [coder]; supersedes f1 (corrected)");
		expect(second.content).not.toContain("f1: first smoke fact");
		expect(second.content).not.toContain("generated_at");

		const persisted = persistedContexts(root);
		expect(persisted.map((context) => context.details.mode)).toEqual(["full", "delta"]);
		expect(persisted.map((context) => context.details.facts)).toEqual([
			{ fromCursor: 0, toCursor: 1 },
			{ fromCursor: 1, toCursor: 2 },
		]);
	});
});
