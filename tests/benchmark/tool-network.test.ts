/**
 * Developer tests for the benchmark tool-network wall builder
 * (benchmark/lib/tool-network.ts — design §4, fakes/README.md §6).
 *
 * The wall's end-to-end behavior (curl + fetch observable denial inside the
 * production driver's spawned tree, root AND delegated, provider exempt,
 * controls outside benchmark mode unaffected) is pinned by the business
 * suite tests/benchmark/tool-network-wall.test.ts (NET-*). These unit tests
 * pin the builder itself: exactly which environment it produces, that the
 * exemption is derived from the configured provider endpoints (and nothing
 * broader), and that ambient proxy configuration cannot punch holes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTmpDirs, loadBenchmarkModule, makeTmpDir } from "./helpers";

afterEach(cleanupTmpDirs);

const {
	providerExemptHostnames,
	toolNetworkWallEnv,
	TOOL_NETWORK_MARKER_ENV,
	TOOL_NETWORK_WALL_PROXY_URL,
} = await loadBenchmarkModule();

function providerEnv(baseUrl: string): Record<string, string | undefined> {
	const root = makeTmpDir("codeflow-bench-netwall-provider-");
	const manifest = path.join(root, "providers.json");
	const models = path.join(root, "models.json");
	fs.writeFileSync(
		manifest,
		JSON.stringify({
			providers: {
				merouter: {
					name: "MeRouter",
					baseUrlEnv: "MEROUTER_BASE_URL",
					apiKeyEnv: "MEROUTER_API_KEY",
					api: "anthropic-messages",
					models: [{ id: "m1", name: "M1" }],
				},
			},
		}),
		"utf8",
	);
	fs.writeFileSync(models, JSON.stringify({ providers: {} }), "utf8");
	return {
		MEROUTER_BASE_URL: baseUrl,
		MEROUTER_API_KEY: "unit-test-key",
		CODEFLOW_PROVIDER_PROFILES_PATH: manifest,
		CODEFLOW_BENCHMARK_MODELS_PATH: models,
	};
}

/** A second provider profile so the exemption set is provably derived from
 * the manifest, not hardcoded to merouter. */
function secondProviderManifest(): string {
	return path.join(makeTmpDir("codeflow-bench-netwall-unit-"), "provider-profiles.json");
}

describe("toolNetworkWallEnv: proxy variables all point at the dead proxy", () => {
	test("every proxy var (upper + lower, scheme + all) is the unlistening loopback proxy", () => {
		const wall = toolNetworkWallEnv(providerEnv("http://localhost:4711"));
		for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
			expect(wall[name]).toBe(TOOL_NETWORK_WALL_PROXY_URL);
		}
		expect(TOOL_NETWORK_WALL_PROXY_URL).toBe("http://127.0.0.1:9");
		expect(wall[TOOL_NETWORK_MARKER_ENV]).toBe("disabled");
	});

	test("ambient proxy configuration is overwritten, never merged — no inherited holes survive", () => {
		const ambient = {
			...providerEnv("http://localhost:4711"),
			HTTP_PROXY: "http://ambient-corp-proxy:8080",
			https_proxy: "socks5://ambient:1080",
			NO_PROXY: "*",
			no_proxy: "internal.example,internal-2.example",
		};
		const wall = toolNetworkWallEnv(ambient);
		expect(wall.HTTP_PROXY).toBe(TOOL_NETWORK_WALL_PROXY_URL);
		expect(wall.https_proxy).toBe(TOOL_NETWORK_WALL_PROXY_URL);
		expect(wall.NO_PROXY).toBe("localhost"); // '*' did not survive
		expect(wall.no_proxy).toBe("localhost"); // the ambient list did not survive either
	});
});

describe("providerExemptHostnames: the exemption is exactly the configured provider endpoints", () => {
	test("a provider base URL host is exempted exactly (hostname, no scheme, port, or path)", () => {
		expect(providerExemptHostnames(providerEnv("http://localhost:4711"))).toEqual(["localhost"]);
		expect(providerExemptHostnames(providerEnv("https://api.example.com/v1"))).toEqual(["api.example.com"]);
	});

	test("a loopback ADDRESS is exempted only when it IS the configured provider endpoint", () => {
		// localhost configured: the plain-address stand-in must NOT ride along.
		expect(providerExemptHostnames(providerEnv("http://localhost:4711"))).not.toContain("127.0.0.1");
		// and the mirror direction: configured on the address, hostname not exempt.
		expect(providerExemptHostnames(providerEnv("http://127.0.0.1:4711"))).toEqual(["127.0.0.1"]);
		expect(providerExemptHostnames(providerEnv("http://127.0.0.1:4711"))).not.toContain("localhost");
	});

	test("no local profile still exempts exactly the checked-in runtime model endpoints", () => {
		expect(providerExemptHostnames({})).toEqual([
			"api.deepseek.com",
			"api.kimi.com",
			"open.bigmodel.cn",
			"token-plan-cn.xiaomimimo.com",
		]);
		const wall = toolNetworkWallEnv({});
		expect(wall.NO_PROXY).toBe(
			"api.deepseek.com,api.kimi.com,open.bigmodel.cn,token-plan-cn.xiaomimimo.com",
		);
		expect(wall.no_proxy).toBe(wall.NO_PROXY);
		expect(wall.NO_PROXY).not.toContain("127.0.0.1");
	});

	test("multiple configured providers: every endpoint host, sorted, deduplicated", () => {
		const manifest = secondProviderManifest();
		fs.writeFileSync(
			manifest,
			JSON.stringify({
				providers: {
					merouter: {
						name: "MeRouter",
						baseUrlEnv: "MEROUTER_BASE_URL",
						apiKeyEnv: "MEROUTER_API_KEY",
						api: "anthropic-messages",
						models: [{ id: "m1", name: "M1" }],
					},
					second: {
						name: "Second",
						baseUrlEnv: "SECOND_BASE_URL",
						apiKeyEnv: "SECOND_API_KEY",
						api: "openai-completions",
						models: [{ id: "s1", name: "S1" }],
					},
				},
			}),
			"utf8",
		);
		const env = {
			MEROUTER_BASE_URL: "https://api.merouter.example",
			SECOND_BASE_URL: "https://second.example",
			CODEFLOW_BENCHMARK_MODELS_PATH: providerEnv("https://unused.example").CODEFLOW_BENCHMARK_MODELS_PATH,
		};
		expect(providerExemptHostnames(env, manifest)).toEqual(["api.merouter.example", "second.example"]);
		expect(toolNetworkWallEnv(env, manifest).NO_PROXY).toBe("api.merouter.example,second.example");
	});

	test("an invalid provider base URL fails loudly (never a silently wider or narrower wall)", () => {
		expect(() => providerExemptHostnames(providerEnv("not-a-url"))).toThrow();
	});
});
