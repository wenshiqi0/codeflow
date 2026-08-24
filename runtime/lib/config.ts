import * as fs from "node:fs";
import * as path from "node:path";

export class ConfigError extends Error {}

interface ExecutorConfig {
	model: string;
	prompt: string;
}

interface RuntimeConfig {
	worker: ExecutorConfig;
	services: { output_compression: ExecutorConfig };
}

export interface ResolvedExecutor {
	provider: string;
	model: string;
	systemPrompt: string;
	promptPath: string;
}

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
		throw new ConfigError("runtime config requires worker and services");
	}
	if (Object.keys(value).some((key) => key !== "worker" && key !== "services")) {
		throw new ConfigError("runtime config contains unknown keys");
	}
	if (Object.keys(value.services).some((key) => key !== "output_compression")) {
		throw new ConfigError("runtime config contains an unknown service");
	}
	return {
		worker: parseExecutor(value.worker, "worker"),
		services: { output_compression: parseExecutor(value.services.output_compression, "services.output_compression") },
	};
}

function resolveExecutor(configFile: string, config: ExecutorConfig, field: string): ResolvedExecutor {
	const separator = config.model.indexOf("/");
	if (separator <= 0 || separator === config.model.length - 1) {
		throw new ConfigError(`${field}.model must be '<provider>/<model>'`);
	}
	const packageRoot = path.dirname(path.dirname(configFile));
	const referencesRoot = path.resolve(packageRoot, "references");
	const promptPath = path.resolve(packageRoot, config.prompt);
	const relative = path.relative(referencesRoot, promptPath);
	if (!promptPath.endsWith(".md") || relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new ConfigError(`${field}.prompt must be Markdown below references/`);
	}
	if (!fs.existsSync(promptPath)) throw new ConfigError(`${field}.prompt is unreadable: ${config.prompt}`);
	return {
		provider: config.model.slice(0, separator),
		model: config.model.slice(separator + 1),
		systemPrompt: fs.readFileSync(promptPath, "utf8"),
		promptPath,
	};
}

export function resolveWorker(configFile: string): ResolvedExecutor {
	return resolveExecutor(configFile, loadRuntimeConfig(configFile).worker, "worker");
}

export function resolveOutputCompression(configFile: string): ResolvedExecutor {
	return resolveExecutor(
		configFile,
		loadRuntimeConfig(configFile).services.output_compression,
		"services.output_compression",
	);
}

export function buildWorkerArgv(
	resolved: ResolvedExecutor,
	prompt: string,
	extensions: string[],
): string[] {
	const argv = [
		"pi",
		"-p", prompt,
		"--mode", "json",
		"--provider", resolved.provider,
		"--model", resolved.model,
		"--system-prompt", resolved.systemPrompt,
		"--no-extensions",
	];
	for (const extension of extensions) argv.push("--extension", extension);
	argv.push("--no-context-files");
	return argv;
}
