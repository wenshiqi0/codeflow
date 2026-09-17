import * as path from "node:path";

/** Pi executes assigned work; codeteam supplies a shared control CLI. */
export const AGENT_TOOL_ALLOWLIST = ["read", "write", "edit", "bash", "collaborate"] as const;

export function agentExtensions(runtimeDir: string): string[] {
	return [
		"provider-profiles",
		"account-pool",
		"codeflow-organization",
		"team-shell",
		"host-guard",
		"codeflow-context",
		"bash-compressor",
		"usage-ledger",
		"agent-watchdog",
	].map((name) => path.join(runtimeDir, "extensions", name, "index.ts"));
}
