import * as path from "node:path";

/** Root and descendants have identical capabilities; position is not a role. */
export const AGENT_TOOL_ALLOWLIST = ["read", "write", "edit", "bash", "collaborate"] as const;

export function agentExtensions(runtimeDir: string): string[] {
	return [
		"provider-profiles",
		"codeflow-organization",
		"host-guard",
		"codeflow-context",
		"bash-compressor",
		"usage-ledger",
		"telemetry-ledger",
		"agent-watchdog",
	].map((name) => path.join(runtimeDir, "extensions", name, "index.ts"));
}
