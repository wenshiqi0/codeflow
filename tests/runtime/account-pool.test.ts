import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AccountPoolError,
	ACCOUNT_POOL_ID_PATTERN,
	accountPoolApiKey,
	accountPoolPaths,
	addPoolAccount,
	advancePoolAccount,
	currentPoolSelection,
	findAccountPool,
	readAccountPools,
	selectPoolAccount,
	type AccountPool,
	type AccountPoolEnv,
} from "../../runtime/lib/account-pool";

const repository = path.resolve(import.meta.dir, "../..");
const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SECRET = "pool-secret-value-that-must-never-leak";

/** A throwaway CODEFLOW_HOME with optional configuration and shared state documents. */
function homeFixture(poolsDocument?: unknown, stateDocument?: unknown) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-account-pool-"));
	directories.push(dir);
	const env: AccountPoolEnv = {
		CODEFLOW_HOME: dir,
		CODEFLOW_ACCOUNT_POOLS_PATH: undefined,
		CODEFLOW_ACCOUNT_POOL_STATE_DIR: undefined,
		POOL_KEY_PRIMARY: `${SECRET}-primary`,
		POOL_KEY_BACKUP: `${SECRET}-backup`,
	};
	if (poolsDocument !== undefined) {
		fs.writeFileSync(
			path.join(dir, "account-pools.json"),
			typeof poolsDocument === "string" ? poolsDocument : JSON.stringify(poolsDocument, null, 2),
		);
	}
	if (stateDocument !== undefined) {
		const stateDir = path.join(dir, "account-pool-state");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(
			path.join(stateDir, "state.json"),
			typeof stateDocument === "string" ? stateDocument : JSON.stringify(stateDocument, null, 2),
		);
	}
	return { dir, env };
}

function poolsDocument() {
	return {
		schema_version: 1,
		pools: [
			{
				model: "custom/model",
				accounts: [
					{ id: "primary", apiKeyEnv: "POOL_KEY_PRIMARY" },
					{ id: "backup", apiKeyEnv: "POOL_KEY_BACKUP" },
					{ id: "third", apiKeyEnv: "POOL_KEY_BACKUP" },
				],
			},
			{ model: "other/model", accounts: [{ id: "only", apiKeyEnv: "POOL_KEY_BACKUP" }] },
		],
	};
}

function poolOf(env: AccountPoolEnv, model = "custom/model"): AccountPool {
	const pool = findAccountPool(readAccountPools(env), model);
	if (!pool) throw new Error("fixture pool is missing");
	return pool;
}

function stateText(env: AccountPoolEnv): string {
	return fs.readFileSync(path.join(accountPoolPaths(env).stateDir, "state.json"), "utf-8");
}

describe("configuration discovery and strict validation", () => {
	test("a missing configuration means no pools, not an error", () => {
		const f = homeFixture();
		expect(readAccountPools(f.env)).toEqual([]);
		expect(accountPoolPaths(f.env).config).toBe(path.join(f.dir, "account-pools.json"));
		expect(accountPoolPaths(f.env).stateDir).toBe(path.join(f.dir, "account-pool-state"));
	});

	test("CODEFLOW_ACCOUNT_POOLS_PATH overrides CODEFLOW_HOME, declaration order is preserved", () => {
		const f = homeFixture();
		const override = path.join(f.dir, "elsewhere.json");
		fs.writeFileSync(override, JSON.stringify(poolsDocument()));
		expect(readAccountPools({ ...f.env, CODEFLOW_ACCOUNT_POOLS_PATH: path.join(f.dir, "absent.json") })).toEqual([]);
		const pools = readAccountPools({ ...f.env, CODEFLOW_ACCOUNT_POOLS_PATH: override });
		expect(pools.map((pool) => pool.model)).toEqual(["custom/model", "other/model"]);
		expect(pools[0].accounts.map((account) => account.id)).toEqual(["primary", "backup", "third"]);
	});

	test("CODEFLOW_ACCOUNT_POOL_STATE_DIR overrides the default state directory", async () => {
		const f = homeFixture(poolsDocument());
		const override = path.join(f.dir, "shared-state");
		const env = { ...f.env, CODEFLOW_ACCOUNT_POOL_STATE_DIR: override };
		expect((await selectPoolAccount(poolOf(env), "backup", env)).account_id).toBe("backup");
		expect(fs.existsSync(path.join(override, "state.json"))).toBe(true);
		expect(fs.existsSync(path.join(f.dir, "account-pool-state"))).toBe(false);
	});

	test("malformed configuration fails loudly without echoing file contents", () => {
		const planted = `LEAKED-${SECRET}`;
		const cases: Array<[string, unknown]> = [
			["not json at all", `{broken ${planted}`],
			["not an object", "[]"],
			["unknown top-level key", { schema_version: 1, pools: [], extra: planted }],
			["wrong schema version", { schema_version: 2, pools: [] }],
			["pools not an array", { schema_version: 1, pools: planted }],
			["pool not an object", { schema_version: 1, pools: [planted] }],
			["pool unknown key", { schema_version: 1, pools: [{ model: "a/b", accounts: [{ id: "x", apiKeyEnv: "K" }], extra: 1 }] }],
			["model without provider", { schema_version: 1, pools: [{ model: "justamodel", accounts: [{ id: "x", apiKeyEnv: "K" }] }] }],
			["duplicate pool model", {
				schema_version: 1,
				pools: [
					{ model: "a/b", accounts: [{ id: "x", apiKeyEnv: "K" }] },
					{ model: "a/b", accounts: [{ id: "y", apiKeyEnv: "K" }] },
				],
			}],
			["empty accounts", { schema_version: 1, pools: [{ model: "a/b", accounts: [] }] }],
			["duplicate account id", {
				schema_version: 1,
				pools: [{ model: "a/b", accounts: [{ id: "x", apiKeyEnv: "K" }, { id: "x", apiKeyEnv: "K" }] }],
			}],
			["account unknown key", { schema_version: 1, pools: [{ model: "a/b", accounts: [{ id: "x", apiKeyEnv: "K", apiKey: planted }] }] }],
			["bad account id", { schema_version: 1, pools: [{ model: "a/b", accounts: [{ id: "../escape", apiKeyEnv: "K" }] }] }],
			["bad api key env name", { schema_version: 1, pools: [{ model: "a/b", accounts: [{ id: "x", apiKeyEnv: "lower-case" }] }] }],
		];
		for (const [name, document] of cases) {
			const f = homeFixture(document);
			let message = "";
			try {
				readAccountPools(f.env);
			} catch (error) {
				expect(error).toBeInstanceOf(AccountPoolError);
				message = (error as Error).message;
			}
			expect(message, name).not.toBe("");
			expect(message, name).not.toContain(planted);
			expect(message, name).not.toContain(SECRET);
		}
	});
});

describe("registration", () => {
	test("registers accounts in order, one model per call, without creating files on rejection", () => {
		const f = homeFixture();
		const env = f.env;
		addPoolAccount("custom/model", { id: "primary", apiKeyEnv: "POOL_KEY_PRIMARY" }, env);
		addPoolAccount("custom/model", { id: "backup", apiKeyEnv: "POOL_KEY_BACKUP" }, env);
		addPoolAccount("custom/another", { id: "other", apiKeyEnv: "POOL_KEY_BACKUP" }, env);
		const pools = readAccountPools(env);
		expect(pools.map((pool) => pool.model)).toEqual(["custom/model", "custom/another"]);
		expect(pools[0].accounts.map((account) => account.id)).toEqual(["primary", "backup"]);
		expect(currentPoolSelection(pools[0], env)).toEqual({ account_id: "primary", generation: 0 });

		const before = fs.readFileSync(path.join(f.dir, "account-pools.json"), "utf-8");
		for (const [name, model, account] of [
			["bad model", "invalid-model", { id: "primary", apiKeyEnv: "POOL_KEY_PRIMARY" }],
			["bad id", "custom/model", { id: "../escape", apiKeyEnv: "POOL_KEY_PRIMARY" }],
			["bad env name", "custom/model", { id: "fresh", apiKeyEnv: "not-an-env-name" }],
			["duplicate id", "custom/model", { id: "primary", apiKeyEnv: "POOL_KEY_BACKUP" }],
		] as Array<[string, string, { id: string; apiKeyEnv: string }]>) {
			expect(() => addPoolAccount(model, account, env), name).toThrow(AccountPoolError);
		}
		expect(fs.readFileSync(path.join(f.dir, "account-pools.json"), "utf-8")).toBe(before);

		// Nothing is written when validation fails before any pool exists either.
		const fresh = homeFixture();
		expect(() => addPoolAccount("invalid-model", { id: "primary", apiKeyEnv: "POOL_KEY_PRIMARY" }, fresh.env)).toThrow(AccountPoolError);
		expect(fs.readdirSync(fresh.dir)).toEqual([]);
	});

	test("registration never writes key values into configuration or state", async () => {
		const f = homeFixture();
		addPoolAccount("custom/model", { id: "primary", apiKeyEnv: "POOL_KEY_PRIMARY" }, f.env);
		await selectPoolAccount(poolOf(f.env), "primary", f.env);
		await advancePoolAccount(poolOf(f.env), { account_id: "primary", generation: 1 }, f.env);
		const configText = fs.readFileSync(path.join(f.dir, "account-pools.json"), "utf-8");
		expect(configText).toContain("POOL_KEY_PRIMARY");
		expect(configText).not.toContain(SECRET);
		expect(stateText(f.env)).not.toContain(SECRET);
		expect(stateText(f.env)).not.toContain("POOL_KEY");
	});
});

describe("selection", () => {
	test("no state: the first declared account at generation 0", () => {
		const f = homeFixture(poolsDocument());
		expect(currentPoolSelection(poolOf(f.env), f.env)).toEqual({ account_id: "primary", generation: 0 });
	});

	test("manual selection is sticky, bumps the generation, and rejects unknown accounts", async () => {
		const f = homeFixture(poolsDocument());
		const pool = poolOf(f.env);
		expect(await selectPoolAccount(pool, "backup", f.env)).toEqual({ account_id: "backup", generation: 1 });
		expect(currentPoolSelection(pool, f.env)).toEqual({ account_id: "backup", generation: 1 });
		expect(await selectPoolAccount(pool, "backup", f.env)).toEqual({ account_id: "backup", generation: 2 });
		expect(await selectPoolAccount(pool, "third", f.env)).toEqual({ account_id: "third", generation: 3 });
		await expect(selectPoolAccount(pool, "missing", f.env)).rejects.toThrow(AccountPoolError);
		expect(currentPoolSelection(pool, f.env)).toEqual({ account_id: "third", generation: 3 });
	});

	test("per-model isolation: switching one pool leaves the other untouched", async () => {
		const f = homeFixture(poolsDocument());
		const other = poolOf(f.env, "other/model");
		expect(await selectPoolAccount(poolOf(f.env), "backup", f.env)).toEqual({ account_id: "backup", generation: 1 });
		expect(currentPoolSelection(other, f.env)).toEqual({ account_id: "only", generation: 0 });
	});

	test("advance moves one position in declaration order and wraps", async () => {
		const f = homeFixture(poolsDocument());
		const pool = poolOf(f.env);
		expect(await advancePoolAccount(pool, { account_id: "primary", generation: 0 }, f.env)).toEqual({ account_id: "backup", generation: 1 });
		expect(currentPoolSelection(pool, f.env)).toEqual({ account_id: "backup", generation: 1 });
		expect(await advancePoolAccount(pool, { account_id: "backup", generation: 1 }, f.env)).toEqual({ account_id: "third", generation: 2 });
		expect(await advancePoolAccount(pool, { account_id: "third", generation: 2 }, f.env)).toEqual({ account_id: "primary", generation: 3 });
	});

	test("a stale failure adopts the concurrent replacement instead of skipping it", async () => {
		const f = homeFixture(poolsDocument());
		const pool = poolOf(f.env);
		const failed = { account_id: "primary", generation: 0 };
		expect(await advancePoolAccount(pool, failed, f.env)).toEqual({ account_id: "backup", generation: 1 });
		// A second process still holding the old selection must not advance to "third".
		expect(await advancePoolAccount(pool, failed, f.env)).toEqual({ account_id: "backup", generation: 1 });
		expect(await advancePoolAccount(pool, { account_id: "primary", generation: 99 }, f.env)).toEqual({ account_id: "backup", generation: 1 });
		expect(currentPoolSelection(pool, f.env)).toEqual({ account_id: "backup", generation: 1 });
		// Manual selection also invalidates in-flight failures.
		const stale = { account_id: "backup", generation: 1 };
		expect(await selectPoolAccount(pool, "third", f.env)).toEqual({ account_id: "third", generation: 2 });
		expect(await advancePoolAccount(pool, stale, f.env)).toEqual({ account_id: "third", generation: 2 });
	});

	test("concurrent processes advance exactly once and share the replacement", async () => {
		const f = homeFixture(poolsDocument());
		const script = `
			import { advancePoolAccount, findAccountPool, readAccountPools } from ${JSON.stringify(path.join(repository, "runtime/lib/account-pool.ts"))};
			const pool = findAccountPool(readAccountPools(process.env), "custom/model");
			if (!pool) throw new Error("fixture pool is missing");
			const selection = await advancePoolAccount(pool, { account_id: "primary", generation: 0 }, process.env);
			process.stdout.write(JSON.stringify(selection));
		`;
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
		Object.assign(env, { CODEFLOW_HOME: f.dir, CODEFLOW_ACCOUNT_POOLS_PATH: "", CODEFLOW_ACCOUNT_POOL_STATE_DIR: "" });
		const children = [0, 1, 2].map(() =>
			Bun.spawn([process.execPath, "-e", script], { cwd: f.dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
		);
		const results = await Promise.all(
			children.map(async (child) => {
				const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
				if (stderr) throw new Error(stderr);
				return JSON.parse(stdout);
			})
		);
		for (const selection of results) expect(selection).toEqual({ account_id: "backup", generation: 1 });
		expect(currentPoolSelection(poolOf(f.env), f.env)).toEqual({ account_id: "backup", generation: 1 });
	});
});

describe("configuration changes and damaged or missing files", () => {
	test("removing the active account falls back to the first account; a failure naming the removed account adopts the replacement", async () => {
		const f = homeFixture(poolsDocument(), { schema_version: 1, selections: { "custom/model": { account_id: "third", generation: 7 } } });
		const trimmed = poolsDocument();
		trimmed.pools[0].accounts = trimmed.pools[0].accounts.filter((account) => account.id !== "third");
		fs.writeFileSync(path.join(f.dir, "account-pools.json"), JSON.stringify(trimmed, null, 2));
		const pool = poolOf(f.env);
		expect(currentPoolSelection(pool, f.env)).toEqual({ account_id: "primary", generation: 7 });
		expect(await advancePoolAccount(pool, { account_id: "primary", generation: 7 }, f.env)).toEqual({ account_id: "backup", generation: 8 });
		// A stale writer that still remembers the removed account cannot regress the generation.
		expect(await advancePoolAccount(pool, { account_id: "third", generation: 6 }, f.env)).toEqual({ account_id: "backup", generation: 8 });
		// Even at the current generation, a failure naming the removed account adopts, it does not advance.
		expect(await advancePoolAccount(pool, { account_id: "third", generation: 8 }, f.env)).toEqual({ account_id: "backup", generation: 8 });
	});

	test("adding an account extends the pool without disturbing the shared selection", async () => {
		const f = homeFixture(poolsDocument(), { schema_version: 1, selections: { "custom/model": { account_id: "backup", generation: 4 } } });
		addPoolAccount("custom/model", { id: "fourth", apiKeyEnv: "POOL_KEY_BACKUP" }, f.env);
		const pool = poolOf(f.env);
		expect(pool.accounts.map((account) => account.id)).toEqual(["primary", "backup", "third", "fourth"]);
		expect(currentPoolSelection(pool, f.env)).toEqual({ account_id: "backup", generation: 4 });
		expect(await selectPoolAccount(pool, "fourth", f.env)).toEqual({ account_id: "fourth", generation: 5 });
	});

	test("an existing but corrupt state file is a hard error and is never overwritten", async () => {
		const f = homeFixture(poolsDocument(), `{corrupt ${SECRET}`);
		const pool = poolOf(f.env);
		let message = "";
		try {
			currentPoolSelection(pool, f.env);
		} catch (error) {
			expect(error).toBeInstanceOf(AccountPoolError);
			message = (error as Error).message;
		}
		expect(message).not.toContain(SECRET);
		await expect(selectPoolAccount(pool, "backup", f.env)).rejects.toThrow(AccountPoolError);
		await expect(advancePoolAccount(pool, { account_id: "primary", generation: 0 }, f.env)).rejects.toThrow(AccountPoolError);
		expect(fs.readFileSync(path.join(accountPoolPaths(f.env).stateDir, "state.json"), "utf-8")).toBe(`{corrupt ${SECRET}`);
	});

	test("generation overflow fails closed without writing an invalid CAS token", async () => {
		const f = homeFixture(poolsDocument());
		const stateDir = path.join(f.dir, "account-pool-state");
		fs.mkdirSync(stateDir, { recursive: true });
		const original = JSON.stringify({ schema_version: 1, selections: { "custom/model": { account_id: "primary", generation: Number.MAX_SAFE_INTEGER } } });
		fs.writeFileSync(path.join(stateDir, "state.json"), original);
		const pool = poolOf(f.env);
		await expect(advancePoolAccount(pool, { account_id: "primary", generation: Number.MAX_SAFE_INTEGER }, f.env)).rejects.toThrow(AccountPoolError);
		await expect(selectPoolAccount(pool, "backup", f.env)).rejects.toThrow(AccountPoolError);
		expect(fs.readFileSync(path.join(stateDir, "state.json"), "utf-8")).toBe(original);
	});

	test("a corrupt configuration is a hard error even with state present", async () => {
		const f = homeFixture(`{broken ${SECRET}`, {
			schema_version: 1,
			selections: { "custom/model": { account_id: "backup", generation: 2 } },
		});
		expect(() => readAccountPools(f.env)).toThrow(AccountPoolError);
		await expect(selectPoolAccount({ model: "custom/model", accounts: [{ id: "primary", apiKeyEnv: "POOL_KEY_PRIMARY" }] }, "primary", f.env)).resolves.toEqual({ account_id: "primary", generation: 3 });
	});

	test("switching fails closed while the state lock is held, reads stay available", async () => {
		const f = homeFixture(poolsDocument(), { schema_version: 1, selections: { "custom/model": { account_id: "backup", generation: 2 } } });
		const lock = path.join(accountPoolPaths(f.env).stateDir, "state.lock");
		fs.writeFileSync(lock, JSON.stringify({ pid: -1 }));
		const pool = poolOf(f.env);
		expect(currentPoolSelection(pool, f.env)).toEqual({ account_id: "backup", generation: 2 });
		await expect(selectPoolAccount(pool, "third", f.env)).rejects.toThrow(/locked/);
		await expect(advancePoolAccount(pool, { account_id: "backup", generation: 2 }, f.env)).rejects.toThrow(/locked/);
		expect(currentPoolSelection(pool, f.env)).toEqual({ account_id: "backup", generation: 2 });
		fs.unlinkSync(lock);
		expect((await selectPoolAccount(pool, "third", f.env)).account_id).toBe("third");
		expect(fs.existsSync(lock)).toBe(false);
	});

	test("a missing state directory is created on the first write", async () => {
		const f = homeFixture(poolsDocument());
		expect(await advancePoolAccount(poolOf(f.env), { account_id: "primary", generation: 0 }, f.env)).toEqual({ account_id: "backup", generation: 1 });
		expect(fs.existsSync(path.join(accountPoolPaths(f.env).stateDir, "state.json"))).toBe(true);
	});
});

describe("key resolution", () => {
	test("resolves the key of the selected account from the environment", () => {
		const f = homeFixture(poolsDocument());
		const selection = { account_id: "backup", generation: 0 };
		expect(accountPoolApiKey(poolOf(f.env), selection, f.env)).toBe(`${SECRET}-backup`);
	});

	test("reports missing variables by name, without leaking other key values", () => {
		const f = homeFixture(poolsDocument());
		const pool = poolOf(f.env);
		expect(() => accountPoolApiKey(pool, { account_id: "primary", generation: 0 }, { ...f.env, POOL_KEY_PRIMARY: undefined })).toThrow(
			/environment variable POOL_KEY_PRIMARY is not set/
		);
		let message = "";
		try {
			accountPoolApiKey(pool, { account_id: "removed", generation: 0 }, f.env);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).not.toBe("");
		expect(message).not.toContain(SECRET);
	});
});

test("the account id pattern matches the registration contract", () => {
	expect(ACCOUNT_POOL_ID_PATTERN.test("a")).toBe(true);
	expect(ACCOUNT_POOL_ID_PATTERN.test("A-b_9".repeat(1))).toBe(true);
	expect(ACCOUNT_POOL_ID_PATTERN.test("0start-hyphen-9")).toBe(true);
	expect(ACCOUNT_POOL_ID_PATTERN.test("../escape")).toBe(false);
	expect(ACCOUNT_POOL_ID_PATTERN.test("has space")).toBe(false);
	expect(ACCOUNT_POOL_ID_PATTERN.test("-leading")).toBe(false);
	expect(ACCOUNT_POOL_ID_PATTERN.test(`${"x".repeat(65)}`)).toBe(false);
});
