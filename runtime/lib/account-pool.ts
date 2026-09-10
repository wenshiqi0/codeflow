/**
 * Fixed-model multi-API-key account pools.
 *
 * A pool registers, for exactly one `provider/model`, an ordered list of
 * accounts. Keys never live in managed files: registration stores the name of
 * the environment variable holding each key, and the shared state directory
 * stores only the active account identity plus a generation counter.
 *
 * Configuration (`CODEFLOW_ACCOUNT_POOLS_PATH`, default
 * `$CODEFLOW_HOME/account-pools.json`) is user-authored and therefore
 * validated strictly: anything malformed fails loudly, and error messages
 * never echo file contents. Shared state (`CODEFLOW_ACCOUNT_POOL_STATE_DIR`,
 * default `$CODEFLOW_HOME/account-pool-state`) holds only the active account
 * identity plus a generation counter: a missing file is a fresh pool, while an
 * existing but unreadable file is a hard error, because silently resetting
 * every process back to the first account would hide real damage.
 *
 * Selection semantics:
 * - No state yet → the first declared account at generation 0.
 * - `selectPoolAccount` (manual, sticky) writes the chosen account and bumps
 *   the generation, so a later stale failure cannot un-select it.
 * - `advancePoolAccount` (automatic, after a model API failure) moves one
 *   position forward in declaration order under a short exclusive file lock,
 *   guarded by a compare-and-swap on the selection (account and generation):
 *   if another process already switched away, or the failed account is no
 *   longer the shared selection, the caller is handed the current selection
 *   unchanged instead of skipping past the shared replacement.
 *
 * Every write bumps the generation by exactly one and refuses to leave the
 * safe-integer range, which makes the selection alone a sufficient CAS token
 * across processes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeJsonAtomic } from "./paths";

/** Failure boundary of every account-pool operation. Never carries file contents or key values. */
export class AccountPoolError extends Error {}

export const ACCOUNT_POOL_SCHEMA_VERSION = 1;
/** `provider/model`, consistent with `parseAccountsCommand`. */
export const ACCOUNT_POOL_MODEL_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./:-]+$/;
export const ACCOUNT_POOL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const ACCOUNT_POOL_KEY_ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export interface AccountPoolAccount {
	id: string;
	/** Name of the environment variable holding this account's API key. */
	apiKeyEnv: string;
}

export interface AccountPool {
	model: string;
	accounts: AccountPoolAccount[];
}

/** The account a pool currently uses, plus the generation that produced it. */
export interface PoolSelection {
	account_id: string;
	generation: number;
}

interface AccountPoolsDocument {
	schema_version: typeof ACCOUNT_POOL_SCHEMA_VERSION;
	pools: AccountPool[];
}

interface PoolStateDocument {
	schema_version: typeof ACCOUNT_POOL_SCHEMA_VERSION;
	selections: Record<string, PoolSelection>;
}

export type AccountPoolEnv = Record<string, string | undefined>;

const LOCK_DEADLINE_MS = 1_000;
const LOCK_POLL_MS = 5;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Where configuration and shared state live for this environment. */
export function accountPoolPaths(env: AccountPoolEnv = process.env): { config: string; stateDir: string } {
	const home = env.CODEFLOW_HOME || path.join(os.homedir(), ".codeflow");
	return {
		config: env.CODEFLOW_ACCOUNT_POOLS_PATH || path.join(home, "account-pools.json"),
		stateDir: env.CODEFLOW_ACCOUNT_POOL_STATE_DIR || path.join(home, "account-pool-state"),
	};
}

/**
 * Validate a parsed configuration document. Field paths, never values, appear
 * in errors so a malformed file cannot leak its own contents.
 */
function parseAccountPoolsDocument(value: unknown): AccountPoolsDocument {
	if (!isRecord(value)) throw new AccountPoolError("account pools configuration must be a JSON object");
	if (Object.keys(value).some((key) => key !== "schema_version" && key !== "pools")) {
		throw new AccountPoolError("account pools configuration contains unknown keys");
	}
	if (value.schema_version !== ACCOUNT_POOL_SCHEMA_VERSION) {
		throw new AccountPoolError(`account pools configuration schema_version must be ${ACCOUNT_POOL_SCHEMA_VERSION}`);
	}
	if (!Array.isArray(value.pools)) throw new AccountPoolError("account pools configuration pools must be an array");
	const models = new Set<string>();
	value.pools.forEach((pool, index) => {
		const where = `pools[${index}]`;
		if (!isRecord(pool)) throw new AccountPoolError(`${where} must be an object`);
		if (Object.keys(pool).some((key) => key !== "model" && key !== "accounts")) {
			throw new AccountPoolError(`${where} contains unknown keys`);
		}
		if (typeof pool.model !== "string" || !ACCOUNT_POOL_MODEL_PATTERN.test(pool.model)) {
			throw new AccountPoolError(`${where}.model must be '<provider>/<model>'`);
		}
		if (models.has(pool.model)) throw new AccountPoolError(`${where} repeats an earlier pool model`);
		models.add(pool.model);
		if (!Array.isArray(pool.accounts) || pool.accounts.length === 0) {
			throw new AccountPoolError(`${where}.accounts must be a non-empty array`);
		}
		const ids = new Set<string>();
		pool.accounts.forEach((account, accountIndex) => {
			const accountWhere = `${where}.accounts[${accountIndex}]`;
			if (!isRecord(account)) throw new AccountPoolError(`${accountWhere} must be an object`);
			if (Object.keys(account).some((key) => key !== "id" && key !== "apiKeyEnv")) {
				throw new AccountPoolError(`${accountWhere} contains unknown keys`);
			}
			if (typeof account.id !== "string" || !ACCOUNT_POOL_ID_PATTERN.test(account.id)) {
				throw new AccountPoolError(`${accountWhere}.id must contain 1-64 letters, digits, underscores or hyphens`);
			}
			if (ids.has(account.id)) throw new AccountPoolError(`${accountWhere} repeats an earlier account id`);
			ids.add(account.id);
			if (typeof account.apiKeyEnv !== "string" || !ACCOUNT_POOL_KEY_ENV_PATTERN.test(account.apiKeyEnv)) {
				throw new AccountPoolError(`${accountWhere}.apiKeyEnv must name an environment variable`);
			}
		});
	});
	return { schema_version: ACCOUNT_POOL_SCHEMA_VERSION, pools: value.pools as AccountPool[] };
}

/**
 * Registered pools in declaration order. A missing configuration file means
 * "nothing is pooled" (models keep their existing single-key setup); a present
 * but malformed file is a hard error.
 */
function readAccountPoolsDocument(config: string): AccountPoolsDocument | null {
	let raw: string;
	try {
		raw = fs.readFileSync(config, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new AccountPoolError(`cannot read account pools configuration: ${path.basename(config)}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new AccountPoolError(`account pools configuration is not valid JSON: ${path.basename(config)}`);
	}
	return parseAccountPoolsDocument(value);
}

export function readAccountPools(env: AccountPoolEnv = process.env): AccountPool[] {
	return readAccountPoolsDocument(accountPoolPaths(env).config)?.pools ?? [];
}

export function findAccountPool(pools: AccountPool[], model: string): AccountPool | undefined {
	return pools.find((pool) => pool.model === model);
}

/**
 * Read shared state. Runtime-owned, but not self-healing: a missing file is
 * a fresh pool, while an existing file that cannot be parsed is a hard error —
 * silently resetting everyone to the first account would hide real damage.
 */
function readPoolState(stateFile: string): PoolStateDocument | null {
	let raw: string;
	try {
		raw = fs.readFileSync(stateFile, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new AccountPoolError(`account pool state is unreadable: ${path.basename(path.dirname(stateFile))}/`);
	}
	const fail = (): never => {
		throw new AccountPoolError(`account pool state is unreadable: ${path.basename(path.dirname(stateFile))}/`);
	};
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return fail();
	}
	if (!isRecord(value) || value.schema_version !== ACCOUNT_POOL_SCHEMA_VERSION || !isRecord(value.selections)) return fail();
	const selections: Record<string, PoolSelection> = {};
	for (const [model, selection] of Object.entries(value.selections)) {
		if (
			!isRecord(selection) ||
			Object.keys(selection).some((key) => key !== "account_id" && key !== "generation") ||
			typeof selection.account_id !== "string" ||
			typeof selection.generation !== "number" ||
			!Number.isSafeInteger(selection.generation) ||
			selection.generation < 0
		) {
			return fail();
		}
		selections[model] = { account_id: selection.account_id, generation: selection.generation };
	}
	return { schema_version: ACCOUNT_POOL_SCHEMA_VERSION, selections };
}

/**
 * A short, shared metadata transaction, never a wait for model work. Crash
 * fails closed: a leftover lock makes switching fail loudly until executions
 * are stopped and the lock is inspected.
 */
function withLock<T>(lockFile: string, fn: () => T): T {
	fs.mkdirSync(path.dirname(lockFile), { recursive: true });
	const deadline = Date.now() + LOCK_DEADLINE_MS;
	let fd: number;
	for (;;) {
		try {
			fd = fs.openSync(lockFile, "wx", 0o600);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) {
				throw new AccountPoolError(
					"account pool state is locked; if its owner crashed, stop codeflow processes before removing the lock file",
				);
			}
			Atomics.wait(waitCell, 0, 0, LOCK_POLL_MS);
		}
	}
	try {
		fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
		return fn();
	} finally {
		fs.closeSync(fd);
		fs.unlinkSync(lockFile);
	}
}

function stateFiles(env: AccountPoolEnv): { stateDir: string; state: string; lock: string } {
	const { stateDir } = accountPoolPaths(env);
	return { stateDir, state: path.join(stateDir, "state.json"), lock: path.join(stateDir, "state.lock") };
}

/** Read the current document (or a fresh one), mutate one selection, persist atomically. */
function writePoolSelection(
	env: AccountPoolEnv,
	pool: AccountPool,
	choose: (stored: PoolSelection | undefined) => PoolSelection,
): PoolSelection {
	const { state, lock } = stateFiles(env);
	return withLock(lock, () => {
		const document = readPoolState(state) ?? { schema_version: ACCOUNT_POOL_SCHEMA_VERSION, selections: {} };
		const selection = choose(document.selections[pool.model]);
		document.selections[pool.model] = selection;
		writeJsonAtomic(state, document);
		return selection;
	});
}

/** Stored selection for a pool, keeping its generation even when its account was removed from the configuration. */
function storedSelection(stateFile: string, pool: AccountPool): PoolSelection | undefined {
	return readPoolState(stateFile)?.selections[pool.model];
}

function effectiveSelection(pool: AccountPool, stored: PoolSelection | undefined): PoolSelection {
	if (stored && pool.accounts.some((account) => account.id === stored.account_id)) return stored;
	// The configured account disappeared (or no state exists): fall back to the
	// first declared account while preserving the generation, so a concurrent
	// CAS still resolves correctly against what other processes remember.
	return { account_id: pool.accounts[0].id, generation: stored?.generation ?? 0 };
}

/** Every write bumps the generation by exactly one; refuse to leave the safe-integer range. */
function bumpGeneration(base: number): number {
	const next = base + 1;
	if (!Number.isSafeInteger(next)) {
		throw new AccountPoolError("account pool generation counter is exhausted; remove the shared state directory to reset");
	}
	return next;
}

/**
 * The account a pool would use now. Never writes: the default is the first
 * declared account at the stored generation.
 */
export function currentPoolSelection(pool: AccountPool, env: AccountPoolEnv = process.env): PoolSelection {
	return effectiveSelection(pool, storedSelection(stateFiles(env).state, pool));
}

/**
 * Manual, sticky selection. Increments the generation so failures observed
 * against the previous selection can never switch away from this choice.
 */
export async function selectPoolAccount(
	pool: AccountPool,
	id: string,
	env: AccountPoolEnv = process.env,
): Promise<PoolSelection> {
	if (!pool.accounts.some((account) => account.id === id)) {
		throw new AccountPoolError(`unknown account '${id}' for this model pool`);
	}
	return writePoolSelection(env, pool, (stored) => ({ account_id: id, generation: bumpGeneration(stored?.generation ?? 0) }));
}

/**
 * Automatic failover: advance one position in declaration order (wrapping),
 * unless the failed selection no longer matches the shared selection — then
 * the current selection is returned unchanged. The compare-and-swap covers
 * both the account and the generation: another process may already have
 * replaced this failure, or the configuration may have replaced the failed
 * account itself. Either way the caller learns which account to retry with.
 */
export async function advancePoolAccount(
	pool: AccountPool,
	failedSelection: PoolSelection,
	env: AccountPoolEnv = process.env,
): Promise<PoolSelection> {
	return writePoolSelection(env, pool, (stored) => {
		const effective = effectiveSelection(pool, stored);
		if (failedSelection.account_id !== effective.account_id || failedSelection.generation !== effective.generation) {
			// Someone else already replaced this failure (or the failed account
			// itself); adopt the shared selection, do not skip past it.
			return effective;
		}
		const index = pool.accounts.findIndex((account) => account.id === effective.account_id);
		const next = pool.accounts[(index + 1) % pool.accounts.length];
		return { account_id: next.id, generation: bumpGeneration(effective.generation) };
	});
}

/**
 * Register an account for a model, appending to the existing pool order (or
 * starting a new pool). Validation happens before any file is touched, so a
 * rejected registration never creates or changes configuration.
 */
export function addPoolAccount(
	model: string,
	account: AccountPoolAccount,
	env: AccountPoolEnv = process.env,
): AccountPool[] {
	if (!ACCOUNT_POOL_MODEL_PATTERN.test(model)) throw new AccountPoolError("model must be '<provider>/<model>'");
	if (!ACCOUNT_POOL_ID_PATTERN.test(account.id)) {
		throw new AccountPoolError("account id must contain 1-64 letters, digits, underscores or hyphens");
	}
	if (!ACCOUNT_POOL_KEY_ENV_PATTERN.test(account.apiKeyEnv)) {
		throw new AccountPoolError("apiKeyEnv must name an environment variable");
	}
	const { config } = accountPoolPaths(env);
	return withLock(`${config}.lock`, () => {
		const document = readAccountPoolsDocument(config) ?? { schema_version: ACCOUNT_POOL_SCHEMA_VERSION, pools: [] };
		const pool = document.pools.find((candidate) => candidate.model === model);
		if (pool) {
			if (pool.accounts.some((candidate) => candidate.id === account.id)) {
				throw new AccountPoolError(`account '${account.id}' is already registered for this model`);
			}
			pool.accounts.push(account);
		} else {
			document.pools.push({ model, accounts: [account] });
		}
		writeJsonAtomic(config, document);
		return document.pools;
	});
}

/**
 * Resolve the API key of a selection from the environment. Reports the
 * variable name, never a key value or file contents.
 */
export function accountPoolApiKey(
	pool: AccountPool,
	selection: PoolSelection,
	env: AccountPoolEnv = process.env,
): string {
	const account = pool.accounts.find((candidate) => candidate.id === selection.account_id);
	if (!account) throw new AccountPoolError(`selection names an account that is not registered for this model`);
	const key = env[account.apiKeyEnv];
	if (typeof key !== "string" || key === "") {
		throw new AccountPoolError(`environment variable ${account.apiKeyEnv} is not set for account '${account.id}'`);
	}
	return key;
}
