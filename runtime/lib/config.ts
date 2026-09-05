import * as fs from "node:fs";
import * as path from "node:path";

export class ConfigError extends Error {}

interface ExecutorConfig {
	model: string;
	prompt: string;
}

interface RuntimeConfig {
	agent: ExecutorConfig;
	services: { output_compression: ExecutorConfig };
}

export interface ResolvedExecutor {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	systemPrompts: string[];
	promptPaths: string[];
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseExecutor(value: unknown, field: string): ExecutorConfig {
	if (!isRecord(value)) throw new ConfigError(`${field} must be an object`);
	const keys = Object.keys(value);
	if (keys.some((key) => key !== "model" && key !== "prompt")) {
		throw new ConfigError(`${field} contains unknown keys`);
	}
	if (typeof value.model !== "string" || value.model.trim() === "") {
		throw new ConfigError(`${field}.model must be a non-empty string`);
	}
	if (typeof value.prompt !== "string" || value.prompt.trim() === "") {
		throw new ConfigError(`${field}.prompt must be a non-empty string`);
	}
	return { model: value.model, prompt: value.prompt };
}

export function loadRuntimeConfig(configFile: string): RuntimeConfig {
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(configFile, "utf8"));
	} catch (error) {
		throw new ConfigError(`cannot read runtime config ${configFile}: ${(error as Error).message}`);
	}
	if (!isRecord(value) || !isRecord(value.services)) {
		throw new ConfigError("runtime config requires agent and services");
	}
	if (Object.keys(value).some((key) => key !== "agent" && key !== "services")) {
		throw new ConfigError("runtime config contains unknown keys");
	}
	if (Object.keys(value.services).some((key) => key !== "output_compression")) {
		throw new ConfigError("runtime config contains an unknown service");
	}
	return {
		agent: parseExecutor(value.agent, "agent"),
		services: { output_compression: parseExecutor(value.services.output_compression, "services.output_compression") },
	};
}

function resolvePrompt(configFile: string, prompt: string, field: string): { content: string; path: string } {
	const packageRoot = path.dirname(path.dirname(configFile));
	const referencesRoot = path.resolve(packageRoot, "references");
	const promptPath = path.resolve(packageRoot, prompt);
	const relative = path.relative(referencesRoot, promptPath);
	if (!promptPath.endsWith(".md") || relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new ConfigError(`${field} must be Markdown below references/`);
	}
	if (!fs.existsSync(promptPath)) throw new ConfigError(`${field} is unreadable: ${prompt}`);
	return { content: fs.readFileSync(promptPath, "utf8"), path: promptPath };
}

function resolveExecutor(
	configFile: string,
	model: string,
	prompts: Array<{ ref: string; field: string }>,
	field: string,
): ResolvedExecutor {
	const separator = model.indexOf("/");
	if (separator <= 0 || separator === model.length - 1) {
		throw new ConfigError(`${field}.model must be '<provider>/<model>'`);
	}
	const resolvedPrompts = prompts.map((prompt) => resolvePrompt(configFile, prompt.ref, prompt.field));
	return {
		provider: model.slice(0, separator),
		model: model.slice(separator + 1),
		systemPrompts: resolvedPrompts.map((prompt) => prompt.content),
		promptPaths: resolvedPrompts.map((prompt) => prompt.path),
	};
}

export function resolveAgent(
	configFile: string,
	modelOverride?: string,
): ResolvedExecutor {
	const agent = loadRuntimeConfig(configFile).agent;
	const resolved = resolveExecutor(
		configFile,
		modelOverride ?? agent.model,
		[{ ref: agent.prompt, field: "agent.prompt" }],
		"agent",
	);
	const modelsFile = path.join(path.dirname(configFile), "models.json");
	let manifest: unknown;
	try {
		manifest = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
	} catch (error) {
		throw new ConfigError(`cannot read models config ${modelsFile}: ${(error as Error).message}`);
	}
	const providers = isRecord(manifest) && isRecord(manifest.providers) ? manifest.providers : {};
	const provider = providers[resolved.provider];
	const models: unknown[] = isRecord(provider) && Array.isArray(provider.models) ? provider.models : [];
	const declaration = models.find((value) => isRecord(value) && value.id === resolved.model);
	if (!isRecord(declaration) || declaration.thinkingLevel === undefined) return resolved;
	if (
		typeof declaration.thinkingLevel !== "string" ||
		!(THINKING_LEVELS as readonly string[]).includes(declaration.thinkingLevel)
	) {
		throw new ConfigError(
			`models.json ${resolved.provider}/${resolved.model}.thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`,
		);
	}
	return { ...resolved, thinkingLevel: declaration.thinkingLevel as ThinkingLevel };
}

export function resolveOutputCompression(configFile: string): ResolvedExecutor {
	const service = loadRuntimeConfig(configFile).services.output_compression;
	return resolveExecutor(configFile, service.model, [
		{ ref: service.prompt, field: "services.output_compression.prompt" },
	], "services.output_compression");
}

export function buildAgentArgv(
	resolved: ResolvedExecutor,
	prompt: string,
	extensions: string[],
	toolAllowlist: readonly string[] | null,
): string[] {
	const argv = [
		"pi",
		"-p", prompt,
		"--mode", "json",
		"--provider", resolved.provider,
		"--model", resolved.model,
		...(resolved.thinkingLevel ? ["--thinking", resolved.thinkingLevel] : []),
		...resolved.systemPrompts.flatMap((systemPrompt) => ["--append-system-prompt", systemPrompt]),
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		...(toolAllowlist ? ["--tools", toolAllowlist.join(",")] : []),
	];
	for (const extension of extensions) argv.push("--extension", extension);
	argv.push("--no-context-files");
	return argv;
}
