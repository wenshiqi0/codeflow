/** Credential-free registration and selection of fixed-model account pools. */
import { readAccountPools, currentPoolSelection, addPoolAccount, selectPoolAccount, type AccountPool } from "../lib/account-pool";

export const ACCOUNTS_HELP = `usage: codeflow accounts <command>

  add <provider/model> <account-id> --key-env <ENV_NAME>
  list [provider/model]
  use <provider/model> <account-id>

Keys stay in environment variables. Registration stores their names only.
`;

export type AccountsCommand =
	| { command: "help" }
	| { command: "list"; model?: string }
	| { command: "add"; model: string; account: string; keyEnv: string }
	| { command: "use"; model: string; account: string };

export function parseAccountsCommand(args: string[]): AccountsCommand {
	if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) return { command: "help" };
	const [command, model, account, flag, keyEnv] = args;
	if (model !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./:-]+$/.test(model)) throw new Error("model must be provider/model");
	if (command === "list" && args.length <= 2) return { command, model };
	if (account !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(account)) throw new Error("account id must contain 1-64 letters, digits, underscores or hyphens");
	if (command === "use" && args.length === 3) return { command, model, account };
	if (command === "add" && args.length === 5 && flag === "--key-env" && /^[A-Z][A-Z0-9_]*$/.test(keyEnv)) return { command, model, account, keyEnv };
	throw new Error(ACCOUNTS_HELP.trim());
}

export async function runAccounts(args: string[], env: Record<string, string | undefined> = process.env): Promise<unknown> {
	const command = parseAccountsCommand(args);
	if (command.command === "help") return ACCOUNTS_HELP;
	if (command.command === "add") await addPoolAccount(command.model, { id: command.account, apiKeyEnv: command.keyEnv }, env);
	const pools = readAccountPools(env).filter(pool => !command.model || pool.model === command.model);
	if (command.model && pools.length === 0) throw new Error("No account pool registered for this model");
	if (command.command === "use") await selectPoolAccount(pools[0], command.account, env);
	return { pools: pools.map((pool: AccountPool) => ({ model: pool.model, accounts: pool.accounts,
		active_account: currentPoolSelection(pool, env).account_id })) };
}

if (import.meta.main) {
	try {
		const result = await runAccounts(process.argv.slice(2));
		process.stdout.write(typeof result === "string" ? result : JSON.stringify(result, null, 2) + "\n");
	} catch (error) {
		process.stderr.write(`codeflow accounts: ${error instanceof Error ? error.message : "operation failed"}\n`);
		process.exitCode = 1;
	}
}
