#!/usr/bin/env bun
/**
 * Delegated-role network probe driver — drives the REAL role launcher
 * (runtime/extensions/codeflow-task/role-launcher.ts) offline and measures
 * what its spawned child can reach (fakes/README.md §6).
 *
 * One file, two modes:
 *
 *  - DRIVER mode (default, no `--mode` in argv): imports the real
 *    `runRoleChild` and runs role "coder" through it, exactly the way a
 *    delegated role is launched in production. runRoleChild resolves the
 *    role from runtime/roles.json, builds the pi argv (extensions included)
 *    and spawns the child with `{ ...process.env, CODEFLOW_AGENT_ROLE,
 *    CODEFLOW_AGENT_DEPTH: "1" }` — so whatever egress wall the benchmark
 *    driver put into the environment flows into the delegated child through
 *    the real inheritance chain.
 *
 *  - PROBE mode (argv contains `--mode json` — the first flags runRoleChild
 *    appends): this same file IS the spawned "pi" child (runRoleChild's
 *    getPiInvocation re-invokes the current script). It performs REAL
 *    outbound attempts — a curl subprocess and a bun fetch, the two HTTP
 *    client families real tools use — to the internet stand-in and to the
 *    provider stand-in, records the outcomes plus its role/depth/prompt
 *    attribution, prints one assistant `message_end` JSON line so
 *    runRoleChild observes success, and exits 0.
 *
 * Outcomes land in `$FAKE_ROLE_NET_CAPTURE/delegated-probe.json` (probe) and
 * `.../delegated-run.json` (driver). All URLs are loopback listeners
 * supplied by the test; nothing here can reach the real internet.
 */

const PROBE_FLAG = "--mode";

interface ProbeOutcome {
	exit: number | null;
	reached: boolean;
}

/** One real outbound attempt with a hard kill timeout. */
async function attempt(url: string): Promise<ProbeOutcome> {
	const killerAfter = 8_000;
	const proc = Bun.spawn(["curl", "-fsS", "--max-time", "5", url], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const killer = setTimeout(() => proc.kill(), killerAfter);
	const exit = await proc.exited;
	clearTimeout(killer);
	return { exit, reached: exit === 0 };
}

async function fetchAttempt(url: string): Promise<ProbeOutcome> {
	const killerAfter = 10_000;
	const script =
		"const u = process.env.PROBE_URL!; try { const r = await fetch(u, { signal: AbortSignal.timeout(5000) });" +
		' if (!r.ok) process.exit(3); process.exit(0); } catch { process.exit(3); }';
	const proc = Bun.spawn([process.execPath, "-e", script], {
		env: { ...process.env, PROBE_URL: url },
		stdout: "pipe",
		stderr: "pipe",
	});
	const killer = setTimeout(() => proc.kill(), killerAfter);
	const exit = await proc.exited;
	clearTimeout(killer);
	return { exit, reached: exit === 0 };
}

function captureDir(): string {
	const dir = process.env.FAKE_ROLE_NET_CAPTURE;
	if (!dir) throw new Error("role-net-driver: FAKE_ROLE_NET_CAPTURE is required");
	return dir;
}

function promptFromArgv(): string {
	const index = process.argv.indexOf("-p");
	return index !== -1 && index + 1 < process.argv.length ? process.argv[index + 1] : "";
}

if (process.argv.includes(PROBE_FLAG)) {
	// ---- PROBE mode: the spawned delegated-role child. -------------------
	const fs = await import("node:fs");
	const path = await import("node:path");
	const internetUrl = process.env.NET_PROBE_URL ?? "";
	const providerUrl = process.env.NET_PROVIDER_URL ?? "";

	const record: Record<string, unknown> = {
		role: process.env.CODEFLOW_AGENT_ROLE ?? null,
		depth: process.env.CODEFLOW_AGENT_DEPTH ?? null,
		prompt_head: promptFromArgv().slice(0, 160),
		at: new Date().toISOString(),
	};
	try {
		record.internet_curl = await attempt(`${internetUrl}delegated`);
		record.internet_fetch = await fetchAttempt(`${internetUrl}delegated`);
		record.provider_curl = await attempt(`${providerUrl}delegated`);
		record.provider_fetch = await fetchAttempt(`${providerUrl}delegated`);
		record.error = null;
	} catch (error) {
		record.error = String(error);
	}
	const dir = captureDir();
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "delegated-probe.json"), `${JSON.stringify(record, null, "\t")}\n`, "utf8");

	process.stdout.write(
		`${JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "netwall delegated probe complete" }],
			},
		})}\n`,
	);
	process.exit(0);
}

// ---- DRIVER mode: run the real role launcher. ---------------------------
const fs = await import("node:fs");
const path = await import("node:path");
const { runRoleChild } = await import("../../../runtime/extensions/codeflow-task/role-launcher");

const dir = captureDir();
fs.mkdirSync(dir, { recursive: true });
const result = await runRoleChild(
	"coder",
	"NETWALL delegated probe: attempt the outbound network checks this environment asks for, then finish.",
	undefined,
	process.cwd(),
);
fs.writeFileSync(
	path.join(dir, "delegated-run.json"),
	`${JSON.stringify(
		{
			success: result.success,
			exitCode: result.exitCode,
			content_head: result.content.slice(0, 200),
			stderr_head: result.stderr.slice(0, 400),
		},
		null,
		"\t",
	)}\n`,
	"utf8",
);
// markers carry the truth; always exit 0 so callers stay simple
process.exit(0);
