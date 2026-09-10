import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { advancePoolAccount, currentPoolSelection, selectPoolAccount, type AccountPool } from "../../runtime/lib/account-pool";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const pool: AccountPool = { model: "test/fixed", accounts: [{ id: "a", apiKeyEnv: "KEY_A" }, { id: "b", apiKeyEnv: "KEY_B" }] };
function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-pool-state-safety-")); directories.push(dir);
	const stateDir = path.join(dir, "account-pool-state"); fs.mkdirSync(stateDir);
	return { env: { CODEFLOW_HOME: dir }, stateFile: path.join(stateDir, "state.json") };
}

test("unreadable or corrupt existing state is not treated as a fresh pool", async () => {
	const f = fixture();
	const original = "{broken-state";
	fs.writeFileSync(f.stateFile, original);
	expect(() => currentPoolSelection(pool, f.env)).toThrow();
	await expect(selectPoolAccount(pool, "b", f.env)).rejects.toThrow();
	expect(fs.readFileSync(f.stateFile, "utf8")).toBe(original);
});

test("a failure for a removed account cannot advance its replacement at the same generation", async () => {
	const f = fixture();
	const failed = await selectPoolAccount(pool, "b", f.env);
	const changed: AccountPool = { ...pool, accounts: [{ id: "c", apiKeyEnv: "KEY_C" }, pool.accounts[0]] };
	expect(currentPoolSelection(changed, f.env)).toEqual({ account_id: "c", generation: failed.generation });
	expect(await advancePoolAccount(changed, failed, f.env)).toEqual({ account_id: "c", generation: failed.generation });
});

test("generation overflow fails without writing an invalid CAS token", async () => {
	const f = fixture();
	const selection = { account_id: "a", generation: Number.MAX_SAFE_INTEGER };
	const original = JSON.stringify({ schema_version: 1, selections: { [pool.model]: selection } });
	fs.writeFileSync(f.stateFile, original);
	await expect(advancePoolAccount(pool, selection, f.env)).rejects.toThrow();
	await expect(selectPoolAccount(pool, "b", f.env)).rejects.toThrow();
	expect(fs.readFileSync(f.stateFile, "utf8")).toBe(original);
});
