#!/usr/bin/env bash
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

section "Dependencies"
if command -v bun >/dev/null 2>&1; then
  BUN_VERSION="$(bun --version 2>/dev/null)"
  BUN_MAJOR="${BUN_VERSION%%.*}"
  BUN_REST="${BUN_VERSION#*.}"
  BUN_MINOR="${BUN_REST%%.*}"
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

if "$RUNTIME_DIR/bin/pi" --version >/dev/null 2>&1; then
  ok "pi runtime reachable"
else
  bad "pi runtime unreachable"
fi

section "Runtime"
for required in \
  "$RUNTIME_DIR/config.json" \
  "$RUNTIME_DIR/models.json" \
  "$RUNTIME_DIR/providers.json.example" \
  "$RUNTIME_DIR/AGENTS.md" \
  "$ROOT_DIR/references/worker.md" \
  "$ROOT_DIR/references/engineering-methods.md" \
  "$ROOT_DIR/references/organization-methods.md" \
  "$RUNTIME_DIR/lib/canonical.ts" \
  "$RUNTIME_DIR/lib/tasks.ts" \
  "$RUNTIME_DIR/lib/goals.ts" \
  "$RUNTIME_DIR/lib/commitment/index.ts" \
  "$RUNTIME_DIR/lib/executions.ts" \
  "$RUNTIME_DIR/lib/state.ts" \
  "$RUNTIME_DIR/lib/inspection.ts" \
  "$RUNTIME_DIR/cli/run.ts" \
  "$RUNTIME_DIR/extensions/codeflow-organization/index.ts" \
  "$RUNTIME_DIR/extensions/codeflow-organization/worker-launcher.ts" \
  "$RUNTIME_DIR/extensions/codeflow-context/index.ts"; do
  if [[ -f "$required" ]]; then
    ok "${required#"$RUNTIME_DIR"/}"
  else
    bad "missing ${required#"$RUNTIME_DIR"/}"
  fi
done

if bun run --cwd "$ROOT_DIR" typecheck >/dev/null 2>&1; then
  ok "runtime TypeScript typecheck"
else
  bad "runtime TypeScript typecheck failed"
fi

if bun "$RUNTIME_DIR/cli/run.ts" debug runtime >/dev/null 2>&1; then
  ok "Worker configuration resolves"
else
  bad "Worker configuration does not resolve"
fi

section "Credentials"
CONFIGURED_KEYS="$(bun -e '
const fs = require("node:fs");
const path = require("node:path");
const runtime = process.argv[1];
const config = JSON.parse(fs.readFileSync(path.join(runtime, "config.json"), "utf8"));
const builtins = JSON.parse(fs.readFileSync(path.join(runtime, "models.json"), "utf8")).providers;
const localPath = path.join(runtime, "providers.json");
const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, "utf8")).providers : {};
const executors = [["worker", config.worker], ...Object.entries(config.services).map(([name, value]) => [`service:${name}`, value])];
const impact = new Map();
for (const [name, executor] of executors) {
  const [provider, ...modelParts] = String(executor.model ?? "").split("/");
  const model = modelParts.join("/");
  const definition = builtins[provider] ?? local[provider];
  if (!definition || !definition.models?.some((entry) => entry.id === model)) process.exit(2);
  const names = definition.baseUrlEnv
    ? [definition.baseUrlEnv, definition.apiKeyEnv]
    : [definition.apiKey?.match(/\$([A-Z0-9_]+)/)?.[1]];
  if (names.some((entry) => !entry)) process.exit(3);
  for (const key of names) impact.set(key, [...(impact.get(key) ?? []), name]);
}
for (const [key, users] of impact) console.log(`${key}\t${users.join(", ")}`);
' "$RUNTIME_DIR" 2>/dev/null)"
if [[ -z "$CONFIGURED_KEYS" ]]; then
  bad "could not derive provider requirements from runtime/config.json"
else
  while IFS=$'\t' read -r key users; do
    [[ -z "$key" ]] && continue
    if [[ -n "${!key:-}" ]]; then
      ok "$key set"
    else
      warn "$key missing — required by: $users"
    fi
  done <<< "$CONFIGURED_KEYS"
fi

section "Result"
printf '  %d ok, %d warn, %d fail\n\n' "$PASS" "$WARN" "$FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  echo "Not ready. Fix the FAIL lines above."
  exit 1
fi
echo "Ready. Start a Task with:"
echo "  codeflow exec \"<objective>\""
