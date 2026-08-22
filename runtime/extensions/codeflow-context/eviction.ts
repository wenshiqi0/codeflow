import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const EVICT_MIN_BYTES = 4_096;
export const EVICT_AFTER_ROUNDS = 8;

export interface EvictToolResultsOptions {
	archiveDir: string;
	sessionId: string;
	/** Messages whose timestamp is at or after this boundary stay verbatim. */
	currentHandoffStartedAt?: number;
	minBytes?: number;
	afterRounds?: number;
}

interface ToolResultLike {
	role?: string;
	toolCallId?: string;
	toolName?: string;
	content?: unknown;
	timestamp?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function textParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((item) => {
		if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return [];
		return [item.text];
	});
}

function archiveId(toolCallId: string, content: Buffer): string {
	const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
	const safeCall = toolCallId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 48);
	return `${safeCall || "tool"}-${digest}`;
}

function atomicWriteText(file: string, content: Buffer): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
	fs.writeFileSync(temporary, content);
	fs.renameSync(temporary, file);
}

function archive(file: string, content: Buffer): boolean {
	try {
		if (fs.existsSync(file)) {
			return fs.readFileSync(file).equals(content);
		}
		atomicWriteText(file, content);
		return true;
	} catch {
		// Evidence preservation wins over token savings: a result that cannot be
		// archived losslessly remains in the provider context.
		return false;
	}
}

function protectedCliOutput(parts: string[]): boolean {
	return parts.some((text) => text.includes("code-agent handoff") || text.includes("code-agent evidence"));
}

export function evictToolResults<T>(messages: T[], options: EvictToolResultsOptions): T[] {
	const minBytes = options.minBytes ?? EVICT_MIN_BYTES;
	const afterRounds = options.afterRounds ?? EVICT_AFTER_ROUNDS;
	const next = [...messages];
	for (let index = 0; index < next.length; index++) {
		const distance = next.length - 1 - index;
		if (distance < afterRounds) continue;
		const message = next[index] as T & ToolResultLike;
		if (message.role !== "toolResult") continue;
		if (typeof message.toolCallId !== "string" || message.toolCallId === "") continue;
		if (
			options.currentHandoffStartedAt !== undefined &&
			(typeof message.timestamp !== "number" ||
				message.timestamp >= options.currentHandoffStartedAt)
		) {
			continue;
		}
		const parts = textParts(message.content);
		if (parts.length === 0 || protectedCliOutput(parts)) continue;
		const content = Buffer.concat(parts.map((part) => Buffer.from(part, "utf8")));
		if (content.length <= minBytes) continue;
		const id = archiveId(message.toolCallId, content);
		const ref = path.join("tool-log", options.sessionId, `${id}.txt`);
		if (!archive(path.join(options.archiveDir, "tool-log", options.sessionId, `${id}.txt`), content)) {
			continue;
		}
		const pointer =
			`[archived tool result: sha256=${createHash("sha256").update(content).digest("hex")} ` +
			`bytes=${content.length} ref=${ref}; retrieve with: code-agent evidence log ${id}]`;
		next[index] = {
			...message,
			content: [{ type: "text", text: pointer }],
		} as T;
	}
	return next;
}
