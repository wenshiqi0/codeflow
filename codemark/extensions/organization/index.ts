/**
 * Codemark's plan-only collaborate surface.
 *
 * The action shapes intentionally match Codeflow's Manager-facing tool, but
 * every mutation is confined to Codemark's private organization artifact. No
 * Worker process is launched and no Codeflow protocol object is written.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	applyOrganizationAction,
	createInitialOrganization,
	readInitialOrganization,
	type CodemarkAction,
} from "../../lib/organization";
import { allowedCodemarkReadTarget } from "../../lib/read-boundary";

const StringArray = Type.Array(Type.String({ minLength: 1 }));
const Effect = Type.Union([
	Type.Object({ git: Type.String({ minLength: 1 }) }),
	Type.Object({ file: Type.String({ minLength: 1 }) }),
	Type.Object({ external: Type.String({ minLength: 1 }) }),
	Type.Object({ service: Type.Record(Type.String(), Type.Unknown()) }),
]);
const ReceiptStatus = Type.Union([
	Type.Literal("progress"),
	Type.Literal("completed"),
	Type.Literal("blocked"),
]);

/** Same fields and order as the production Root collaborate surface. */
export const CODEMARK_ACTION_SCHEMAS = {
	inspect: Type.Object({
		name: Type.Literal("inspect"),
		goal_id: Type.Optional(Type.String({ minLength: 1 })),
		commitment_id: Type.Optional(Type.String({ minLength: 1 })),
		receipt_id: Type.Optional(Type.String({ minLength: 1 })),
	}, {
		additionalProperties: false,
		description: "Recall a Goal, Commitment, or Receipt by id. Omit ids for the current Goal.",
	}),
	claim: Type.Object({
		name: Type.Literal("claim"),
		work: Type.String({ minLength: 1, maxLength: 600 }),
		done_when: Type.Optional(StringArray),
		constraints: Type.Optional(StringArray),
	}, {
		additionalProperties: false,
		description: "Create this Worker's bounded Commitment.",
	}),
	report: Type.Object({
		name: Type.Literal("report"),
		status: ReceiptStatus,
		summary: Type.String({ minLength: 1 }),
		effects: Type.Optional(Type.Array(Effect)),
		remaining: Type.Optional(StringArray),
	}, {
		additionalProperties: false,
		description: "Report progress, completion, or a blocker. Before claim, only blocked is valid.",
	}),
	delegate: Type.Object({
		name: Type.Literal("delegate"),
		goal_id: Type.Optional(Type.String({ minLength: 1 })),
		new_goal: Type.Optional(Type.Object({
			goal_id: Type.String({ minLength: 1 }),
			objective: Type.String({ minLength: 1 }),
			dependencies: Type.Optional(StringArray),
		}, { additionalProperties: false })),
		focus: Type.String({ minLength: 1 }),
		resume_commitment_id: Type.Optional(Type.String({ minLength: 1 })),
	}, {
		additionalProperties: false,
		description: "Root only: start a Worker. Set exactly one of goal_id (reuse) or new_goal (create).",
	}),
	wait: Type.Object({
		name: Type.Literal("wait"),
		execution_id: Type.Optional(Type.String({ minLength: 1 })),
	}, {
		additionalProperties: false,
		description: "Root only: when the next management decision cannot proceed without a Worker result, yield until one named Worker (or any Worker) claims work, reports progress, or ends.",
	}),
} as const;

export const codemarkCollaborateParameters = Type.Object({
	action: Type.Union([
		CODEMARK_ACTION_SCHEMAS.inspect,
		CODEMARK_ACTION_SCHEMAS.claim,
		CODEMARK_ACTION_SCHEMAS.report,
		CODEMARK_ACTION_SCHEMAS.delegate,
		CODEMARK_ACTION_SCHEMAS.wait,
	]),
}, { additionalProperties: false });

type SchemaShape = {
	properties?: Record<string, SchemaShape>;
	required?: string[];
	items?: SchemaShape | SchemaShape[];
	$ref?: string;
};

/** Mirror Pi's pre-execution TypeBox normalization and conversion. */
function normalizeOptionalNulls(value: unknown, schema: SchemaShape): void {
	if (Array.isArray(value)) {
		if (Array.isArray(schema.items)) {
			for (let index = 0; index < value.length; index += 1) {
				const itemSchema = schema.items[index];
				if (itemSchema) normalizeOptionalNulls(value[index], itemSchema);
			}
		} else if (schema.items) {
			for (const item of value) normalizeOptionalNulls(item, schema.items);
		}
		return;
	}
	if (typeof value !== "object" || value === null || !schema.properties) return;
	const record = value as Record<string, unknown>;
	const required = new Set(schema.required ?? []);
	for (const [key, propertySchema] of Object.entries(schema.properties)) {
		if (!(key in record)) continue;
		if (
			record[key] === null
			&& !required.has(key)
			&& typeof propertySchema.$ref !== "string"
			&& !Value.Check(propertySchema as never, null)
		) {
			delete record[key];
		} else {
			normalizeOptionalNulls(record[key], propertySchema);
		}
	}
}

/** Return the exact arguments Pi would pass to execute(), or null if Pi rejects them. */
export function prepareCodemarkArguments(rawArguments: unknown): { action: CodemarkAction } | null {
	try {
		const prepared = structuredClone(rawArguments);
		normalizeOptionalNulls(prepared, codemarkCollaborateParameters as unknown as SchemaShape);
		Value.Convert(codemarkCollaborateParameters, prepared);
		return Value.Check(codemarkCollaborateParameters, prepared)
			? prepared as { action: CodemarkAction }
			: null;
	} catch {
		return null;
	}
}

function executableWait(rawArguments: unknown): boolean {
	const prepared = prepareCodemarkArguments(rawArguments);
	if (prepared?.action.name !== "wait") return false;
	return prepared.action.execution_id === undefined
		|| prepared.action.execution_id.trim() !== "";
}

interface CollaborateToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
	terminate?: boolean;
}

function result(value: unknown, details?: unknown): CollaborateToolResult {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details,
	};
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value || value.trim() === "") throw new Error(`Codemark requires ${name}`);
	return value;
}

/** Keep the Manager's read tool from observing private harness process state. */
export function codemarkReadBoundaryViolation(
	rawPath: string,
	cwd: string,
	repository: string,
	privateRunDir: string,
): string | null {
	return allowedCodemarkReadTarget(rawPath, cwd, repository, privateRunDir) === null
		? "read target is unavailable"
		: null;
}

function issueFromFile(file: string): string {
	const content = fs.readFileSync(file, "utf8");
	try {
		const parsed = JSON.parse(content) as unknown;
		if (
			parsed !== null
			&& typeof parsed === "object"
			&& !Array.isArray(parsed)
			&& typeof (parsed as { issue?: unknown }).issue === "string"
		) {
			return (parsed as { issue: string }).issue;
		}
		if (typeof parsed === "string") return parsed;
	} catch {
		// A plain-text Issue is the normal file format.
	}
	return content;
}

function ensureOrganization(runDir: string, cwd: string): void {
	try {
		readInitialOrganization(runDir);
		return;
	} catch (error) {
		if (!String(error).includes("does not exist")) throw error;
	}
	const issueFile = process.env.CODEMARK_ISSUE_FILE;
	const issue = issueFile ? issueFromFile(issueFile) : process.env.CODEMARK_ISSUE;
	if (!issue || issue.trim() === "") {
		throw new Error("Codemark requires CODEMARK_ISSUE_FILE or CODEMARK_ISSUE when its artifact is not initialized");
	}
	createInitialOrganization(runDir, {
		runId: process.env.CODEMARK_RUN_ID ?? path.basename(runDir),
		issue,
		repository: cwd,
		manager: {
			provider: process.env.CODEMARK_MANAGER_PROVIDER,
			model: process.env.CODEMARK_MANAGER_MODEL,
			thinking_level: process.env.CODEMARK_MANAGER_THINKING_LEVEL,
			prompt_paths: process.env.CODEMARK_MANAGER_PROMPT_PATHS
				? JSON.parse(process.env.CODEMARK_MANAGER_PROMPT_PATHS) as string[]
				: process.env.CODEMARK_MANAGER_PROMPT_PATH
					? [process.env.CODEMARK_MANAGER_PROMPT_PATH]
					: [],
		},
	});
}

export default function (pi: ExtensionAPI): void {
	let currentBatchResults: CollaborateToolResult[] = [];
	let terminalBatch = false;
	let invalidCollaborateCallsInBatch = 0;
	const supersededToolCalls = new Set<string>();
	const invalidWaitToolCalls = new Set<string>();
	pi.on?.("message_end", (event) => {
		const message = event.message as {
			role?: unknown;
			content?: Array<{
				type?: unknown;
				id?: unknown;
				name?: unknown;
				arguments?: Record<string, unknown>;
			}>;
		};
		if (message.role !== "assistant") return;
		currentBatchResults = [];
		invalidCollaborateCallsInBatch = 0;
		supersededToolCalls.clear();
		invalidWaitToolCalls.clear();
		const content = message.content ?? [];
		const firstWaitIndex = content.findIndex((entry) => {
			if (entry.type !== "toolCall" || entry.name !== "collaborate") return false;
			const action = entry.arguments?.action;
			return action !== null
				&& typeof action === "object"
				&& (action as { name?: unknown }).name === "wait";
		});
		terminalBatch = firstWaitIndex >= 0;
		if (firstWaitIndex >= 0) {
			let messageModified = false;
			const retainedContent = content.filter((entry, index) => {
				if (entry.type !== "toolCall") return true;
				const afterWait = index > firstWaitIndex;
				const nonCollaborate = entry.name !== "collaborate";
				const invalidCollaborate = index < firstWaitIndex
					&& entry.name === "collaborate"
					&& prepareCodemarkArguments(entry.arguments) === null;
				if (!afterWait && !nonCollaborate && !invalidCollaborate) return true;
				messageModified = true;
				if (invalidCollaborate) invalidCollaborateCallsInBatch += 1;
				if (typeof entry.id === "string") supersededToolCalls.add(entry.id);
				return false;
			});
			const firstWait = content[firstWaitIndex];
			if (!executableWait(firstWait.arguments)) {
				// Pi rejects invalid tool arguments before execute(). A wait-shaped call
				// or production rejects an all-whitespace execution id in execute(). A
				// wait-shaped call must still freeze this one-response benchmark. Replace
				// only this control call and preserve the invalidity in the assessment.
				firstWait.arguments = {
					action: { name: "wait" },
				};
				if (typeof firstWait.id === "string") invalidWaitToolCalls.add(firstWait.id);
				messageModified = true;
			}
			if (messageModified) {
				message.content = retainedContent;
				return { message: event.message };
			}
		}
	});
	pi.on?.("tool_call", (event) => {
		if (
			supersededToolCalls.has(event.toolCallId)
			|| (terminalBatch && event.toolName !== "collaborate")
		) {
			return {
				block: true,
				reason: "tool call superseded by the terminal wait in this batch",
				terminate: true,
			};
		}
		if (event.toolName !== "read") return;
		const rawPath = (event.input as { path?: unknown }).path;
		if (typeof rawPath !== "string") return;
		const runDir = requiredEnvironment("CODEMARK_RUN_DIR");
		const repository = requiredEnvironment("CODEMARK_REPOSITORY");
		const canonical = allowedCodemarkReadTarget(rawPath, process.cwd(), repository, runDir);
		if (canonical === null) return { block: true, reason: "read target is unavailable" };
		// Reuse the permitted canonical path instead of following the raw symlink again.
		(event.input as { path: string }).path = canonical;
		return;
	});
	pi.on?.("turn_end", () => {
		currentBatchResults = [];
		terminalBatch = false;
		invalidCollaborateCallsInBatch = 0;
		supersededToolCalls.clear();
		invalidWaitToolCalls.clear();
	});
	pi.registerTool({
		name: "collaborate",
		label: "Collaborate",
		description: "Coordinate Goal-scoped work. Use inspect, claim, report, delegate, or wait. Root alone can create Goals and delegate Workers.",
		parameters: codemarkCollaborateParameters,
		executionMode: "sequential",
		async execute(id, rawParams, _signal, _update, ctx) {
			const runDir = requiredEnvironment("CODEMARK_RUN_DIR");
			ensureOrganization(runDir, ctx.cwd);
			const action = (rawParams as { action: CodemarkAction }).action;
			let transition;
			try {
				transition = applyOrganizationAction(
					runDir,
					action,
					undefined,
					action.name === "wait" && invalidWaitToolCalls.has(id)
						? { waitSchemaValid: false, invalidCollaborateCalls: invalidCollaborateCallsInBatch }
						: { invalidCollaborateCalls: invalidCollaborateCallsInBatch },
				);
			} catch (error) {
				if (!terminalBatch && action.name !== "wait") throw error;
				const toolResult = result({
					error: error instanceof Error ? error.message : String(error),
				});
				toolResult.terminate = true;
				currentBatchResults.push(toolResult);
				if (action.name === "wait") {
					for (const prior of currentBatchResults) prior.terminate = true;
					ctx.abort();
					ctx.shutdown();
				}
				return toolResult;
			}
			const toolResult = result(transition.result, transition.result);
			currentBatchResults.push(toolResult);
			if (action.name === "wait") {
				// The completed artifact is durable before either termination signal.
				// Core termination requires every result in one tool batch to opt in.
				for (const prior of currentBatchResults) prior.terminate = true;
				ctx.abort();
				ctx.shutdown();
				return toolResult;
			}
			return toolResult;
		},
	});
}
