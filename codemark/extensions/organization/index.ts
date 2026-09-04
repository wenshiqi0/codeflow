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
import {
	applyOrganizationAction,
	finalizeOrganization,
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
} as const;

export const codemarkCollaborateParameters = Type.Object({
	action: Type.Union([
		CODEMARK_ACTION_SCHEMAS.inspect,
		CODEMARK_ACTION_SCHEMAS.claim,
		CODEMARK_ACTION_SCHEMAS.report,
		CODEMARK_ACTION_SCHEMAS.delegate,
	]),
}, { additionalProperties: false });

interface CollaborateToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
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
	let abnormalEndSeen = false;
	pi.on("tool_call", (event) => {
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
	pi.on("agent_end", (event, ctx) => {
		// Pi emits agent_end for errors, truncation and aborts too. Only a natural
		// final assistant response freezes the measured initial organization.
		const assistants = event.messages.filter((message) => message.role === "assistant");
		const last = assistants.at(-1);
		abnormalEndSeen ||= assistants.some((message) => Boolean(message.errorMessage)
			|| ["error", "aborted", "length"].includes(message.stopReason));
		if (abnormalEndSeen || !last || last.stopReason !== "stop"
			|| last.content.some((entry) => entry.type === "toolCall")) return;
		const runDir = requiredEnvironment("CODEMARK_RUN_DIR");
		ensureOrganization(runDir, ctx.cwd);
		finalizeOrganization(runDir, { termination: "first_turn_end" });
	});
	pi.registerTool({
		name: "collaborate",
		label: "Collaborate",
		description: "Coordinate Goal-scoped work. Use inspect, claim, report, or delegate. Root alone can create Goals and delegate Workers.",
		parameters: codemarkCollaborateParameters,
		executionMode: "sequential",
		async execute(_id, rawParams, _signal, _update, ctx) {
			const runDir = requiredEnvironment("CODEMARK_RUN_DIR");
			ensureOrganization(runDir, ctx.cwd);
			const action = (rawParams as { action: CodemarkAction }).action;
			const transition = applyOrganizationAction(runDir, action);
			return result(transition.result, transition.result);
		},
	});
}
