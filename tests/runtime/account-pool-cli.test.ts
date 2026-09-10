import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repository = path.resolve(import.meta.dir, "../..");
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-accounts-cli-")); directories.push(dir);
	const env = { ...process.env, CODEFLOW_HOME: dir, CLI_KEY_A: "private-value-must-not-appear" };
	delete env.CODEFLOW_ACCOUNT_POOLS_PATH;
	delete env.CODEFLOW_ACCOUNT_POOL_STATE_DIR;
	// Metadata operations must not source or execute credential configuration.
	fs.writeFileSync(path.join(dir, ".env"), "touch \"$CODEFLOW_HOME/env-was-executed\"\n");
	function run(args: string[]) {
		const result = Bun.spawnSync(["bash", path.join(repository, "runtime/bin/codeflow"), "accounts", ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
		const stdout = result.stdout.toString(), stderr = result.stderr.toString();
		expect(stdout + stderr).not.toContain(env.CLI_KEY_A);
		expect(fs.existsSync(path.join(dir, "env-was-executed"))).toBe(false);
		return { code: result.exitCode, stdout, stderr, data: result.exitCode === 0 && stdout.trim().startsWith("{") ? JSON.parse(stdout) : null };
	}
	return { dir, run };
}

describe("account registration CLI", () => {
	test("help and an empty listing work without credentials or configuration writes", () => {
		const f = fixture();
		const help = f.run(["--help"]);
		expect(help.code).toBe(0); expect(help.stdout).toContain("--key-env");
		const result = f.run(["list"]);
		expect(result.code).toBe(0); expect(result.data.pools).toEqual([]);
		expect(fs.readdirSync(f.dir)).toEqual([".env"]);
	});

	test("registers ordered accounts for exactly one model and persists explicit selection", () => {
		const f = fixture();
		expect(f.run(["add", "custom/model", "primary", "--key-env", "CLI_KEY_A"]).code).toBe(0);
		expect(f.run(["add", "custom/model", "backup", "--key-env", "CLI_KEY_B"]).code).toBe(0);
		expect(f.run(["add", "custom/another-model", "other", "--key-env", "CLI_KEY_C"]).code).toBe(0);
		let row = f.run(["list", "custom/model"]).data.pools[0];
		expect(row.model).toBe("custom/model");
		expect(row.accounts.map((account: any) => account.id)).toEqual(["primary", "backup"]);
		expect(row.active_account).toBe("primary");
		expect(f.run(["use", "custom/model", "backup"]).code).toBe(0);
		row = f.run(["list", "custom/model"]).data.pools[0];
		expect(row.active_account).toBe("backup");
		expect(f.run(["list", "custom/another-model"]).data.pools[0].active_account).toBe("other");
	});

	test("rejects malformed registration, duplicate identities, and unknown selections without changing configuration", () => {
		const f = fixture();
		for (const args of [
			["add", "invalid-model", "primary", "--key-env", "CLI_KEY_A"],
			["add", "custom/model", "../escape", "--key-env", "CLI_KEY_A"],
			["add", "custom/model", "primary", "--key-env", "raw-secret-with-dashes"],
			["add", "custom/model", "primary", "--key-env", "CLI_KEY_A", "extra"],
			["add", "custom/model", "primary", "--api-key", "private-value-must-not-appear"],
		]) expect(f.run(args).code).not.toBe(0);
		expect(fs.readdirSync(f.dir)).toEqual([".env"]);
		expect(f.run(["add", "custom/model", "primary", "--key-env", "CLI_KEY_A"]).code).toBe(0);
		const before = f.run(["list"]).stdout;
		expect(f.run(["add", "custom/model", "primary", "--key-env", "CLI_KEY_B"]).code).not.toBe(0);
		expect(f.run(["use", "custom/model", "missing"]).code).not.toBe(0);
		expect(f.run(["use", "missing/model", "primary"]).code).not.toBe(0);
		expect(f.run(["list"]).stdout).toBe(before);
	});
});
