/**
 * Register local provider profiles whose endpoints are supplied by the caller
 * environment. Pi intentionally does not interpolate baseUrl in models.json,
 * so dynamic endpoints are loaded from the gitignored providers.json file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ProviderConfig,
	type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PROVIDER_PROFILES_PATH = path.join(RUNTIME_DIR, "providers.json");
export const PROVIDER_PROFILES_PATH_ENV = "CODEFLOW_PROVIDER_PROFILES_PATH";

interface ProviderProfile {
	name: string;
	baseUrlEnv: string;
	apiKeyEnv: string;
	api: ProviderConfig["api"];
	models: ProviderModelConfig[];
}

interface ProviderProfilesManifest {
	providers: Record<string, ProviderProfile>;
}

export interface ConfiguredProviderProfile {
	id: string;
	/** configuredProviderProfiles() only yields profiles whose baseUrl was
	 * resolved from the environment and validated, so `baseUrl` is always a
	 * non-empty string here even though the library type keeps it optional. */
	config: ProviderConfig & { baseUrl: string };
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

function parseManifest(file: string): ProviderProfilesManifest {
	let source: string;
	try {
		source = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
		throw error;
	}
	const parsed = JSON.parse(source) as Partial<ProviderProfilesManifest>;
	if (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
		throw new Error(`invalid provider profile manifest: ${file}`);
	}
	return parsed as ProviderProfilesManifest;
}

function validateProfile(id: string, profile: ProviderProfile): void {
	if (!id || id.includes("/")) throw new Error(`invalid provider profile id: ${id}`);
	if (!ENV_NAME.test(profile.baseUrlEnv)) {
		throw new Error(`provider ${id}: invalid baseUrlEnv`);
	}
	if (!ENV_NAME.test(profile.apiKeyEnv)) {
		throw new Error(`provider ${id}: invalid apiKeyEnv`);
	}
	if (!profile.api || !Array.isArray(profile.models) || profile.models.length === 0) {
		throw new Error(`provider ${id}: api and at least one model are required`);
	}
}

function validateBaseUrl(id: string, envName: string, value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`provider ${id}: ${envName} must be an absolute HTTP(S) URL`);
	}
	if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) {
		throw new Error(`provider ${id}: ${envName} must use HTTP or HTTPS`);
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error(`provider ${id}: ${envName} must not contain credentials, query, or fragment`);
	}
	return value;
}

export function configuredProviderProfiles(
	env: Record<string, string | undefined> = process.env,
	manifestPath = env[PROVIDER_PROFILES_PATH_ENV]?.trim() || PROVIDER_PROFILES_PATH,
): ConfiguredProviderProfile[] {
	const manifest = parseManifest(manifestPath);
	const configured: ConfiguredProviderProfile[] = [];

	for (const [id, profile] of Object.entries(manifest.providers)) {
		validateProfile(id, profile);
		const rawBaseUrl = env[profile.baseUrlEnv]?.trim();
		if (!rawBaseUrl) continue;
		const baseUrl = validateBaseUrl(id, profile.baseUrlEnv, rawBaseUrl);
		configured.push({
			id,
			config: {
				name: profile.name,
				baseUrl,
				apiKey: `$${profile.apiKeyEnv}`,
				api: profile.api,
				models: profile.models,
			},
		});
	}

	return configured;
}

export default function (pi: ExtensionAPI): void {
	for (const provider of configuredProviderProfiles()) {
		pi.registerProvider(provider.id, provider.config);
	}
}
