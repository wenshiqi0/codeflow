#!/usr/bin/env bash
# Preflight check for the codeflow runtime.
#
# Runs before a real task so a missing dependency or key surfaces here rather
# than as a PROVIDER_FAILURE halfway through a run — cheaper to read, and it
# does not burn tokens to discover.
#
# Exit codes: 0 ready, 1 blocking problem found.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/runtime"

PASS=0
FAIL=0
WARN=0

ok()   { printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }
warn() { printf '  warn  %s\n' "$1"; WARN=$((WARN + 1)); }
section() { printf '\n%s\n' "$1"; }

# --- dependencies ---------------------------------------------------------

section "Dependencies"

if command -v bun >/dev/null 2>&1; then
  BUN_VERSION="$(bun --version 2>/dev/null)"
  BUN_MAJOR="${BUN_VERSION%%.*}"
  BUN_REST="${BUN_VERSION#*.}"
  BUN_MINOR="${BUN_REST%%.*}"
  # Bun 1.3+ : extensions and CLI are TypeScript loaded with no build step.
  if [[ "$BUN_MAJOR" -gt 1 ]] || { [[ "$BUN_MAJOR" -eq 1 ]] && [[ "$BUN_MINOR" -ge 3 ]]; }; then
    ok "bun $BUN_VERSION"
  else
    bad "bun $BUN_VERSION is too old; 1.3+ required"
  fi
else
  bad "bun not found — install from https://bun.sh"
fi

if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | cut -d' ' -f3)"
else
  bad "git not found"
fi

# The pi shim owns discovery, so ask it rather than duplicating the search.
if "$RUNTIME_DIR/bin/pi" --version >/dev/null 2>&1; then
  ok "pi runtime reachable"
else
  bad "pi not found — bun install -g @earendil-works/pi-coding-agent"
fi

# --- credentials ----------------------------------------------------------

section "Credentials"

# Credential presence is checked from the caller environment. The optional
# .env file remains a runtime launcher concern and is not reported here.

# Derive endpoint/credential impact from provider registries plus runtime/agents bindings.
# Doctor never owns a second copy of the roster.
KEY_ROLES="$(bun -e '
const fs = require("node:fs");
const path = require("node:path");
const runtime = process.argv[1];
const staticProviders = JSON.parse(fs.readFileSync(path.join(runtime, "models.json"), "utf8")).providers;
const profileProviders = JSON.parse(fs.readFileSync(path.join(runtime, "provider-profiles.json"), "utf8")).providers;
const agents = path.join(runtime, "agents");
const impact = new Map();
for (const file of fs.readdirSync(agents).filter((name) => name.endsWith(".md")).sort()) {
  const text = fs.readFileSync(path.join(agents, file), "utf8");
  const match = /^model:\s*([^#\n]+)/m.exec(text);
  if (!match) continue;
  const binding = match[1].trim();
  const separator = binding.indexOf("/");
  const provider = binding.slice(0, separator);
  const model = binding.slice(separator + 1);
  const config = staticProviders[provider] ?? profileProviders[provider];
  if (!config || !config.models?.some((entry) => entry.id === model)) {
    console.error(`role ${file} has no configured provider/model: ${binding}`);
    process.exit(1);
  }
  const envNames = config.baseUrlEnv
    ? [config.baseUrlEnv, config.apiKeyEnv]
    : [config.apiKey?.match(/\$([A-Z0-9_]+)/)?.[1]];
  if (envNames.some((name) => !name)) {
    console.error(`role ${file} has incomplete provider configuration: ${binding}`);
    process.exit(1);
  }
  for (const envName of envNames) {
    impact.set(envName, [...(impact.get(envName) ?? []), file.replace(/\.md$/, "")]);
  }
}
for (const [key, roles] of impact) console.log(`${key}\t${roles.join(", ")}`);
' "$RUNTIME_DIR" 2>/dev/null)"
if [[ -z "$KEY_ROLES" ]]; then
  bad "could not derive provider requirements from runtime configuration and agents"
else
  while IFS=$'\t' read -r key roles; do
    [[ -z "$key" ]] && continue
    if [[ -n "${!key:-}" ]]; then
      ok "$key set"
    else
      bad "$key missing — blocks: $roles"
    fi
  done <<< "$KEY_ROLES"
fi

# --- runtime integrity ----------------------------------------------------

section "Runtime"

for required in \
  "$RUNTIME_DIR/models.json" \
  "$RUNTIME_DIR/provider-profiles.json" \
  "$RUNTIME_DIR/AGENTS.md" \
  "$RUNTIME_DIR/lib/handoff/index.ts" \
  "$RUNTIME_DIR/lib/facts.ts" \
  "$RUNTIME_DIR/lib/seq.ts" \
  "$RUNTIME_DIR/lib/wait.ts" \
  "$RUNTIME_DIR/lib/goals.ts" \
  "$RUNTIME_DIR/cli/run.ts" \
  "$RUNTIME_DIR/cli/handoff.ts" \
  "$RUNTIME_DIR/extensions/codeflow-task/index.ts" \
  "$RUNTIME_DIR/extensions/codeflow-task/registry.ts" \
  "$RUNTIME_DIR/extensions/codeflow-task/role-launcher.ts" \
  "$RUNTIME_DIR/extensions/codeflow-task/shared.ts" \
  "$RUNTIME_DIR/extensions/host-guard/index.ts" \
  "$RUNTIME_DIR/extensions/host-guard/policy.ts" \
  "$RUNTIME_DIR/extensions/codeflow-context/index.ts" \
  "$RUNTIME_DIR/extensions/codeflow-context/imports.ts" \
  "$RUNTIME_DIR/extensions/provider-profiles/index.ts" \
  "$RUNTIME_DIR/extensions/usage-ledger/index.ts" \
  "$RUNTIME_DIR/extensions/bash-compressor/index.ts" \
  "$RUNTIME_DIR/extensions/agent-watchdog/index.ts"; do
  if [[ -f "$required" ]]; then
    ok "${required#"$RUNTIME_DIR"/}"
  else
    bad "missing ${required#"$RUNTIME_DIR"/}"
  fi
done

# Undefined imports/references in runtime TypeScript are exactly the class of
# regression that tests can miss when a split module is only partially exercised.
if [[ -f "$ROOT_DIR/tsconfig.json" ]] && bun "$ROOT_DIR/node_modules/.bin/tsc" -p "$ROOT_DIR/tsconfig.json" >/dev/null 2>&1; then
  ok "runtime TypeScript typecheck"
else
  bad "runtime TypeScript typecheck failed (bun run typecheck)"
fi

# Every role must resolve to a provider from the static or dynamic registry. A typo here
# fails at model-call time, which is the most expensive place to learn it.
ROLES="$(bun "$RUNTIME_DIR/cli/run.ts" debug agent 2>/dev/null)"
if [[ -z "$ROLES" ]]; then
  bad "no agent roles found"
else
  ROLE_COUNT=0
  ROLE_BAD=0
  while IFS= read -r role; do
    [[ -z "$role" ]] && continue
    ROLE_COUNT=$((ROLE_COUNT + 1))
    if ! bun "$RUNTIME_DIR/cli/run.ts" delegate --role "$role" --print "probe" >/dev/null 2>&1; then
      bad "role $role does not resolve (check its model: line against provider registries)"
      ROLE_BAD=$((ROLE_BAD + 1))
    fi
  done <<< "$ROLES"
  if [[ "$ROLE_BAD" -eq 0 ]]; then
    ok "$ROLE_COUNT roles resolve to configured providers"
  fi
fi

# --- verdict --------------------------------------------------------------

section "Result"
printf '  %d ok, %d warn, %d fail\n\n' "$PASS" "$WARN" "$FAIL"

if [[ "$FAIL" -gt 0 ]]; then
  echo "Not ready. Fix the FAIL lines above."
  exit 1
fi

echo "Ready. Start a run with:"
echo "  codeflow exec \"<requirement>\""
exit 0
