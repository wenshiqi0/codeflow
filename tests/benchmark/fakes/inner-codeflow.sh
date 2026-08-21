#!/usr/bin/env bash
# Fake inner `codeflow` binary for the PRODUCTION driver-script tests
# (tests/benchmark/driver-streaming.test.ts).
#
# runtime/scripts/benchmark/codeflow-driver.ts spawns the real thing as
#   bash <bin> exec "<prompt>"
# with cwd = the attempt workspace and the staging ledger dir in
# CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR. This fake speaks that exact spawn form
# (selected via CODEFLOW_BENCHMARK_CODEFLOW_BIN) and appends rows in the same
# schema runtime/extensions/benchmark-ledger writes, so the tests can prove the
# production driver tails the ledgers WHILE this process is alive and forwards
# SIGTERM to it — offline, no model, no network.
#
# FAKE_INNER_MODE:
#   scripted — round 1; sleep; tool t-1 (requested + result); sleep; round 2;
#              a pending t-2 request that never terminates; sleep; exit 0.
#   forever  — one 400k-token round every FAKE_INNER_INTERVAL_MS, writing
#              step-<i>.py after each round's sleep (partial work), until
#              SIGTERM (never finishes on its own inside test timeouts).
#   fail     — one round, then exit 3 (exit-code mirroring).
#   netprobe — the tool-network wall probe (fakes/README.md §6): REAL
#              outbound attempts (curl + bun fetch) from inside the spawned
#              Codeflow tree to NET_PROBE_URL (internet stand-in) and
#              NET_PROVIDER_URL (provider stand-in), then the delegated-role
#              chain through the REAL role-launcher
#              (NET_ROLE_NET_DRIVER), writing netprobe-root.json. Extra env:
#              NET_PROBE_BUN (bun binary), NET_SKIP_DELEGATED=1 (controls).
#
# Markers under FAKE_INNER_CAPTURE_DIR:
#   inner-pid            this process's pid, written before anything else
#   inner-argv           the argv received (the prompt for `exec`)
#   inner-terminated     written by the SIGTERM trap, WITH the row counts of
#                        the runner-written attempt ledgers (usage.jsonl /
#                        tool-calls.jsonl one dir above the workspace) at kill
#                        time — the crossing round must already be durable
#   inner-natural-exit   written only when the script completes on its own
set -u

capture="${FAKE_INNER_CAPTURE_DIR:?FAKE_INNER_CAPTURE_DIR is required}"
# The staging ledger dir the production driver always provides; controls
# that run outside benchmark mode get a scratch dir instead.
ledger="${CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR:-$capture/ledger}"
mkdir -p "$capture" "$ledger"
echo $$ >"$capture/inner-pid"
printf '%s\n' "$*" >"$capture/inner-argv"

now() { date -u "+%Y-%m-%dT%H:%M:%S.000Z"; }

usage_row() { # $1=role $2=model $3=total_tokens
	printf '{"schema_version":2,"at":"%s","request_started_at":null,"attempt":%d,"run_id":null,"role":"%s","provider":"fake-anthropic","model":"%s","depth":0,"turn":1,"handoff_id":null,"goal_id":null,"lane":null,"usage":{"input":%d,"output":100,"reasoning":0,"cache_read":0,"cache_write":0,"total_tokens":%d,"cost":null}}\n' \
		"$(now)" "${CODEFLOW_BENCHMARK_ATTEMPT:-1}" "$1" "$2" "$(($3 - 100))" "$3" >>"$ledger/usage.jsonl"
}

tool_row() { # $1=kind $2=call_id $3=status ("-" for null) [$4=provider] [$5=model]
	# Mirrors runtime/extensions/benchmark-ledger: every staging tool row
	# carries DIRECT provider/model attribution from the emitting round.
	local status="null"
	[ "$3" != "-" ] && status="\"$3\""
	printf '{"schema_version":1,"kind":"%s","call_id":"%s","tool":"bash","status":%s,"at":"%s","run_id":null,"role":"coder","provider":"%s","model":"%s","depth":0,"handoff_id":null,"goal_id":null,"lane":null}\n' \
		"$1" "$2" "$status" "$(now)" "${4:-fake-anthropic}" "${5:-fake-coder}" >>"$ledger/tool-calls.jsonl"
}

# Fractional sleep that works on every macOS/bash host (no sleep 0.4 reliance).
msleep() { perl -e 'select(undef, undef, undef, shift() / 1000)' "$1"; }

# What the runner's attempt ledgers hold right now (they live one dir above
# the workspace — the same derivation the production driver uses).
observe() {
	local usage=0 tools=0
	[ -f "../usage.jsonl" ] && usage=$(grep -c . ../usage.jsonl)
	[ -f "../tool-calls.jsonl" ] && tools=$(grep -c . ../tool-calls.jsonl)
	printf '{"pid":%s,"at":"%s","usage_rows":%s,"tool_rows":%s}\n' $$ "$(now)" "$usage" "$tools"
}

trap 'observe >"$capture/inner-terminated"; exit 0' TERM

trap 'observe >"$capture/inner-terminated"; exit 0' TERM

# ---- netprobe helpers (fakes/README.md §6) ------------------------------
# One REAL outbound attempt per client family; the URL is a loopback
# listener supplied by the test (nothing here can reach the real internet).
probe_curl() { # $1=url -> exit code
	curl -fsS --max-time 5 "$1" >/dev/null 2>&1
	echo $?
}
probe_fetch() { # $1=url -> ok|fail (bun fetch in a fresh process)
	if PROBE_URL="$1" "${NET_PROBE_BUN:-bun}" -e \
			'try { const r = await fetch(process.env.PROBE_URL, { signal: AbortSignal.timeout(5000) }); if (!r.ok) process.exit(3); process.exit(0); } catch { process.exit(3); }' \
			2>/dev/null; then
		echo ok
	else
		echo fail
	fi
}
probe_markers() { # names of set env vars that look proxy/benchmark related
	env | cut -d= -f1 | grep -iE 'proxy|benchmark' | sort | paste -sd, -
}

case "${FAKE_INNER_MODE:-scripted}" in
scripted)
	usage_row coder fake-coder 400000
	msleep 500
	tool_row requested t-1 -
	tool_row result t-1 succeeded
	msleep 500
	usage_row coder fake-coder 400000
	tool_row requested t-2 -
	msleep 500
	printf '{"mode":"scripted"}\n' >"$capture/inner-natural-exit"
	exit 0
	;;
forever)
	interval="${FAKE_INNER_INTERVAL_MS:-400}"
	i=0
	while [ "$i" -lt 500 ]; do
		i=$((i + 1))
		usage_row coder fake-coder 400000
		msleep "$interval"
		# Partial work exists from the first round on, so any cap stop has a
		# non-empty patch to extract and grade.
		printf 'STEP_%d = True\n' "$i" >"step-$i.py"
	done
	printf '{"mode":"forever"}\n' >"$capture/inner-natural-exit"
	exit 0
	;;
fail)
	usage_row coder fake-coder 400000
	msleep 400
	exit 3
	;;
netprobe)
	# The attempt is a live benchmark attempt like any other: one round.
	usage_row coder fake-coder 5000
	# ROOT-ROLE probes: real outbound attempts from the process the production
	# driver spawned (where a root-role bash tool subprocess would run). The
	# marker shape matches role-net-driver.ts: {exit, reached} per attempt.
	ic="$(probe_curl "${NET_PROBE_URL}root")"
	if_="$(probe_fetch "${NET_PROBE_URL}root")"
	pc="$(probe_curl "${NET_PROVIDER_URL}root")"
	pf="$(probe_fetch "${NET_PROVIDER_URL}root")"
	bool() { [ "$1" = "ok" ] || [ "$1" = "0" ] && echo true || echo false; }
	printf '{"mode":"netprobe","internet_curl":{"exit":%s,"reached":%s},"internet_fetch":{"reached":%s},"provider_curl":{"exit":%s,"reached":%s},"provider_fetch":{"reached":%s},"env_markers":"%s"}\n' \
		"$ic" "$(bool "$ic")" "$(bool "$if_")" "$pc" "$(bool "$pc")" "$(bool "$pf")" "$(probe_markers)" >"$capture/netprobe-root.json"
	# DELEGATED-ROLE chain: this script stands where the root pi process
	# stands; the REAL role-launcher (NET_ROLE_NET_DRIVER) spawns its pi
	# child with the env inherited from the production driver, and that
	# child performs the same probes (delegated-probe.json / delegated-run.json).
	if [ "${NET_SKIP_DELEGATED:-0}" != "1" ] && [ -n "${NET_ROLE_NET_DRIVER:-}" ]; then
		"${NET_PROBE_BUN:-bun}" "${NET_ROLE_NET_DRIVER}" >"$capture/delegated-driver.log" 2>&1 || true
	fi
	printf '{"mode":"netprobe"}\n' >"$capture/inner-natural-exit"
	exit 0
	;;
*)
	echo "inner-codeflow: unknown FAKE_INNER_MODE: ${FAKE_INNER_MODE:-}" >&2
	exit 2
	;;
esac
