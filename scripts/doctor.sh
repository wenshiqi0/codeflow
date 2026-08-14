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
CODEFLOW_HOME="${CODEFLOW_HOME:-$HOME/.codeflow}"

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

if [[ -f "$CODEFLOW_HOME/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$CODEFLOW_HOME/.env"
  set +a
  ok "loaded $CODEFLOW_HOME/.env"
else
  warn "no $CODEFLOW_HOME/.env (fine if keys are exported in your shell)"
fi

# Report which roles a missing key takes out, so the impact is concrete rather
# than an abstract "key missing".
check_key() {
  local name="$1" roles="$2"
  if [[ -n "${!name:-}" ]]; then
    ok "$name set"
  else
    bad "$name missing — blocks: $roles"
  fi
}

check_key ZHIPU_API_KEY    "planner"
check_key KIMI_API_KEY     "coder, test-writer"
check_key MIMO_API_KEY     "test-runner, command, supervisor, title-compressor"
check_key DEEPSEEK_API_KEY "(unused by default bindings)"

# --- runtime integrity ----------------------------------------------------

section "Runtime"

for required in \
  "$RUNTIME_DIR/models.json" \
  "$RUNTIME_DIR/AGENTS.md" \
  "$RUNTIME_DIR/lib/handoff.ts" \
  "$RUNTIME_DIR/lib/facts.ts" \
  "$RUNTIME_DIR/lib/seq.ts" \
  "$RUNTIME_DIR/lib/wait.ts" \
  "$RUNTIME_DIR/lib/cli-run.ts" \
  "$RUNTIME_DIR/lib/cli-handoff.ts" \
  "$RUNTIME_DIR/extensions/codeflow-task/index.ts" \
  "$RUNTIME_DIR/extensions/codeflow-context/index.ts" \
  "$RUNTIME_DIR/extensions/agent-watchdog/index.ts"; do
  if [[ -f "$required" ]]; then
    ok "${required#"$RUNTIME_DIR"/}"
  else
    bad "missing ${required#"$RUNTIME_DIR"/}"
  fi
done

# Every role must resolve to a provider that exists in models.json. A typo here
# fails at model-call time, which is the most expensive place to learn it.
ROLES="$(bun "$RUNTIME_DIR/lib/cli-run.ts" debug agent 2>/dev/null)"
if [[ -z "$ROLES" ]]; then
  bad "no agent roles found"
else
  ROLE_COUNT=0
  ROLE_BAD=0
  while IFS= read -r role; do
    [[ -z "$role" ]] && continue
    ROLE_COUNT=$((ROLE_COUNT + 1))
    if ! bun "$RUNTIME_DIR/lib/cli-run.ts" run --agent "$role" --print "probe" >/dev/null 2>&1; then
      bad "role $role does not resolve (check its model: line against models.json)"
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
echo "  codeflow run --agent planner \"<requirement>\""
exit 0
