/**
 * The benchmark tool-network wall (docs/benchmark-design.md §4, contract
 * §1.7.1, tests/benchmark/fakes/README.md §6, TESTPLAN "NET-*").
 *
 * Benchmark mode must MECHANICALLY deny outbound network access for Agent
 * tool execution — in the root role AND in every delegated-role child —
 * while the model-provider network stays separately reachable. A manifest
 * field or a prompt line is a declaration, not enforcement; the wall must
 * fail REAL outbound attempts made by ORDINARY HTTP clients (a curl
 * subprocess, a bun/undici fetch) with zero parsing of tool arguments.
 *
 * Mechanism — environment variables, the one egress control stock HTTP
 * clients already honor, applied by benchmark/scripts/
 * codeflow-driver.ts to the env of its spawned Codeflow tree:
 *
 *  - every proxy variable (HTTP(S)_PROXY / ALL_PROXY, upper- and lowercase)
 *    points at an unlistening loopback port, so every non-exempt attempt is
 *    routed into "connection refused" in milliseconds — offline,
 *    deterministic, no DNS, no firewall, fail-closed;
 *  - NO_PROXY / no_proxy lists EXACTLY the hostnames of the run's
 *    model-provider endpoints: checked-in runtime/models.json plus every
 *    configured local providers.json profile whose baseUrlEnv is set. That
 *    is §4's separate provider channel, kept
 *    direct and reachable from the SAME walled tree. Nothing broader is
 *    exempt — not "*", not blanket loopback ("127.0.0.1"), no ambient
 *    NO_PROXY merge — so a loopback address that is not a configured
 *    provider endpoint stays walled;
 *  - delegated roles inherit the wall: runtime/extensions/codeflow-task/
 *    role-launcher.ts spreads { ...process.env } into its spawned children.
 *
 * Scope: applied ONLY by the benchmark driver to its spawned Codeflow run.
 * No Codeflow command or exec outside benchmark mode reads or inherits it,
 * and runner-side infra channels (dataset fetch via hub-fetch.ts, the
 * evaluator harness) are spawned outside this env and stay reachable — the
 * manifest declares the two networks separately (tool_network vs
 * model_provider_network) precisely because they are enforced separately.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { configuredProviderProfiles } from "../../runtime/extensions/provider-profiles";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RUNTIME_DIR = path.join(REPO_ROOT, "runtime");
const RUNTIME_MODELS_PATH = path.join(RUNTIME_DIR, "models.json");
export const BENCHMARK_MODELS_PATH_ENV = "CODEFLOW_BENCHMARK_MODELS_PATH";

/**
 * The dead egress proxy every non-exempt request is routed into: port 9 on
 * loopback is not a listener on any standard host, so connections are
 * refused instantly (the same offline guard the hub-pinning tests use).
 */
export const TOOL_NETWORK_WALL_PROXY_URL = "http://127.0.0.1:9";

/** Marker written into the walled env; mirrors the manifest vocabulary (`tool_network: disabled`). */
export const TOOL_NETWORK_MARKER_ENV = "CODEFLOW_BENCHMARK_TOOL_NETWORK";

const WALL_PROXY_ENV_VARS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
] as const;

/**
 * Hostnames of the provider endpoints for this runtime — the ONLY hosts the
 * wall exempts. Static providers come from runtime/models.json; dynamic local
 * providers come from providers.json through the same loader that registers
 * them. Invalid base URLs fail loudly before the spawned run begins.
 */
export function providerExemptHostnames(
	env: Record<string, string | undefined> = process.env,
	manifestPath?: string,
): string[] {
	const hostnames = new Set<string>();
	const modelsPath = env[BENCHMARK_MODELS_PATH_ENV]?.trim() || RUNTIME_MODELS_PATH;
	const modelsDocument = JSON.parse(fs.readFileSync(modelsPath, "utf8")) as {
		providers?: Record<string, { baseUrl?: unknown }>;
	};
	for (const [id, provider] of Object.entries(modelsDocument.providers ?? {})) {
		if (typeof provider.baseUrl !== "string" || provider.baseUrl.trim() === "") {
			throw new Error(`runtime model provider ${id}: baseUrl must be a non-empty absolute URL`);
		}
		const parsed = new URL(provider.baseUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error(`runtime model provider ${id}: baseUrl must use HTTP or HTTPS`);
		}
		const hostname = parsed.hostname.toLowerCase();
		if (hostname.length > 0) hostnames.add(hostname);
	}
	for (const profile of configuredProviderProfiles(env, manifestPath)) {
		const hostname = new URL(profile.config.baseUrl).hostname.toLowerCase();
		if (hostname.length > 0) hostnames.add(hostname);
	}
	return [...hostnames].sort();
}

/**
 * The wall env for the spawned Codeflow tree: all proxy vars → the dead
 * proxy, NO_PROXY → exactly the provider hostnames. Ambient proxy
 * configuration is OVERWRITTEN, never merged — an inherited NO_PROXY="*" or
 * an ambient corporate proxy must not punch holes through the wall, and the
 * wall must not behave differently depending on the host's proxy setup.
 */
export function toolNetworkWallEnv(
	env: Record<string, string | undefined> = process.env,
	manifestPath?: string,
): Record<string, string> {
	const exempt = providerExemptHostnames(env, manifestPath).join(",");
	const wall: Record<string, string> = {};
	for (const name of WALL_PROXY_ENV_VARS) wall[name] = TOOL_NETWORK_WALL_PROXY_URL;
	wall.NO_PROXY = exempt;
	wall.no_proxy = exempt;
	wall[TOOL_NETWORK_MARKER_ENV] = "disabled";
	return wall;
}
