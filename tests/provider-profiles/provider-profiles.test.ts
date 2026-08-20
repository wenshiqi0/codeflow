import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	configuredProviderProfiles,
	PROVIDER_PROFILES_PATH,
} from "../../runtime/extensions/provider-profiles";
import { readRoleDefinition } from "../../runtime/lib/roles";

const runtimeDir = path.resolve(import.meta.dir, "../../runtime");
const examplePath = path.join(runtimeDir, "providers.json.example");
const missingPath = path.join(runtimeDir, "providers.json.missing");

describe("provider profiles", () => {
	test("the local providers file is optional", () => {
		expect(PROVIDER_PROFILES_PATH).toBe(path.join(runtimeDir, "providers.json"));
		expect(configuredProviderProfiles({}, missingPath)).toEqual([]);
	});

	test("registers a provider from the checked-in example", () => {
		const [provider] = configuredProviderProfiles(
			{
				CUSTOM_ANTHROPIC_BASE_URL: "https://router.example.test/anthropic",
				CUSTOM_ANTHROPIC_API_KEY: "must-not-be-copied",
			},
			examplePath,
		);

		expect(provider.id).toBe("custom-anthropic");
		expect(provider.config).toMatchObject({
			name: "Custom Anthropic Provider",
			baseUrl: "https://router.example.test/anthropic",
			apiKey: "$CUSTOM_ANTHROPIC_API_KEY",
			api: "anthropic-messages",
		});
		expect(provider.config.apiKey).not.toContain("must-not-be-copied");
		expect(provider.config.models).toEqual([
			expect.objectContaining({
				id: "example-model",
				reasoning: true,
				contextWindow: 200_000,
				maxTokens: 8_192,
			}),
		]);
	});

	test("rejects unsafe or non-HTTP base URLs before provider registration", () => {
		for (const baseUrl of [
			"relative/path",
			"file:///tmp/router",
			"https://user:secret@router.example.test",
			"https://router.example.test?token=secret",
		]) {
			expect(() =>
				configuredProviderProfiles({ CUSTOM_ANTHROPIC_BASE_URL: baseUrl }, examplePath),
			).toThrow();
		}
	});

	test("the checked-in example documents the provider metadata shape", () => {
		const manifest = JSON.parse(fs.readFileSync(examplePath, "utf8"));
		expect(Object.keys(manifest.providers)).toEqual(["custom-anthropic"]);
		expect(manifest.providers["custom-anthropic"]).toMatchObject({
			baseUrlEnv: "CUSTOM_ANTHROPIC_BASE_URL",
			apiKeyEnv: "CUSTOM_ANTHROPIC_API_KEY",
		});
	});

	test("the launcher contains no provider-specific environment handling", () => {
		const launcher = fs.readFileSync(path.join(runtimeDir, "bin", "codeflow"), "utf8");
		expect(launcher).not.toContain("CUSTOM_ANTHROPIC");
	});

	test("the planner remains bound to GLM 5.3", () => {
		const planner = readRoleDefinition(path.join(runtimeDir, "roles.json"), "planner");
		expect(planner?.model).toBe("zhipuai-coding-plan/glm-5.3");
	});
});
