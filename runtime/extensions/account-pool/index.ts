import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { readAccountPools } from "../../lib/account-pool";
import { pooledStream } from "../../lib/account-pool-stream";

/** A pool changes request credentials for the explicitly selected fixed model. */
export default function accountPoolExtension(pi: ExtensionAPI): void {
	let installed = false;
	const install = (_event: unknown, ctx: ExtensionContext) => {
		if (installed) return;
		try {
			const pools = readAccountPools();
			if (!ctx.model) return;
			const model = ctx.model;
			const pool = pools.find(entry => entry.model === `${model.provider}/${model.id}`);
			if (!pool) return;
			const provider = ctx.modelRegistry.getProvider(model.provider);
			if (!provider) throw new Error("Account pool provider unavailable");
			pi.registerProvider(model.provider, {
				// Pi resolves provider authentication before dispatching streamSimple.
				// The placeholder is replaced inside every pooled request, including
				// when the original single-key environment variable is absent.
				apiKey: "CODEFLOW_ACCOUNT_POOL_MANAGED", api: model.api,
				baseUrl: model.baseUrl, models: [...provider.getModels()],
				streamSimple: pooledStream(pool, provider.streamSimple.bind(provider), process.env, {
					progress: () => pi.events.emit("codeflow:account-pool-progress", {}),
					discarded: message => pi.events.emit("codeflow:account-pool-discarded", message),
					switch: event => process.stderr.write(`[codeflow:account-switch] ${JSON.stringify(event)}\n`),
				}),
			} satisfies ProviderConfig);
			installed = true;
		} catch {
			process.stderr.write("codeflow: invalid account pool configuration\n");
			process.exit(1);
		}
	};
	pi.on("session_start", install);
}
