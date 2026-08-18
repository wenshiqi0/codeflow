import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	configuredProviderProfiles,
	PROVIDER_PROFILES_PATH,
} from "../../runtime/extensions/provider-profiles";

const runtimeDir = path.resolve(import.meta.dir, "../../runtime");

describe("provider profiles", () => {
	test("merouter is optional and does not disturb existing providers", () => {
		expect(configuredProviderProfiles({})).toEqual([]);
		const staticProviders = JSON.parse(
			fs.readFileSync(path.join(runtimeDir, "models.json"), "utf8"),
		).providers;
		expect(staticProviders).not.toHaveProperty("merouter");
	});

	test("registers Claude Opus 5 under an isolated merouter provider", () => {
		const [provider] = configuredProviderProfiles({
			MEROUTER_BASE_URL: "https://router.example.test/anthropic",
			MEROUTER_API_KEY: "must-not-be-copied",
		});

		expect(provider.id).toBe("merouter");
		expect(provider.config).toMatchObject({
			name: "MeRouter",
			baseUrl: "https://router.example.test/anthropic",
			apiKey: "$MEROUTER_API_KEY",
			api: "anthropic-messages",
		});
		expect(provider.config.apiKey).not.toContain("must-not-be-copied");
		expect(provider.config.models).toEqual([
			expect.objectContaining({
				id: "claude-opus-5",
				reasoning: true,
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				compat: expect.objectContaining({ forceAdaptiveThinking: true }),
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
			expect(() => configuredProviderProfiles({ MEROUTER_BASE_URL: baseUrl })).toThrow();
		}
	});

	test("the checked-in manifest is the provider metadata source", () => {
		const manifest = JSON.parse(fs.readFileSync(PROVIDER_PROFILES_PATH, "utf8"));
		expect(Object.keys(manifest.providers)).toEqual(["merouter"]);
		expect(manifest.providers.merouter).toMatchObject({
			baseUrlEnv: "MEROUTER_BASE_URL",
			apiKeyEnv: "MEROUTER_API_KEY",
		});
	});

	test("the pinned Pi runtime resolves merouter/claude-opus-5 without a provider request", () => {
		const result = Bun.spawnSync({
			cmd: [
				path.join(runtimeDir, "bin", "pi"),
				"--no-extensions",
				"--extension",
				path.join(runtimeDir, "extensions", "provider-profiles", "index.ts"),
				"--list-models",
				"merouter",
			],
			cwd: path.resolve(runtimeDir, ".."),
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: runtimeDir,
				MEROUTER_BASE_URL: "https://router.example.test/anthropic",
				MEROUTER_API_KEY: "test-only",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = result.stdout.toString();
		expect(result.exitCode).toBe(0);
		expect(stdout).toContain("merouter");
		expect(stdout).toContain("claude-opus-5");
		expect(stdout).not.toContain("test-only");
	});

	test("the launcher preserves shell overrides for both merouter values", () => {
		const launcher = fs.readFileSync(path.join(runtimeDir, "bin", "codeflow"), "utf8");
		expect(launcher).toContain('INHERITED_MEROUTER_BASE_URL="${MEROUTER_BASE_URL:-}"');
		expect(launcher).toContain('INHERITED_MEROUTER_API_KEY="${MEROUTER_API_KEY:-}"');
	});

	test("the planner remains bound to GLM 5.3", () => {
		const planner = fs.readFileSync(path.join(runtimeDir, "agents", "planner.md"), "utf8");
		expect(planner).toMatch(/^model: zhipuai-coding-plan\/glm-5\.3$/m);
	});
});
