import { createAssistantMessageEventStream, isContextOverflow, type Api, type AssistantMessage, type Context, type Model, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import { advancePoolAccount, currentPoolSelection, type AccountPool } from "./account-pool";

export type PoolFailure = "authentication" | "balance" | "throttled" | "deadline" | "transport" | "service" | "rejected" | "cancelled";

/** Inspect provider status/text internally; only bounded categories leave this boundary. */
export function classifyPoolFailure(message: AssistantMessage, status?: number, signal?: AbortSignal): PoolFailure {
	if (signal?.aborted || message.stopReason === "aborted") return "cancelled";
	if (isContextOverflow(message)) return "rejected";
	const error = message.errorMessage ?? "";
	if (/insufficient[_ ](?:quota|balance|funds|credits?)|(?:quota|credit|budget).{0,25}(?:exceed|exhaust|deplet)|out of (?:budget|credit)|available balance|余额不足|欠费|配额.{0,10}(?:耗尽|不足)/i.test(error) || status === 402) return "balance";
	if (status === 401 || status === 403) return "authentication";
	if (status === 429) return "throttled";
	if (status === 408) return "deadline";
	if (status !== undefined && status >= 500 && status <= 599) return "service";
	if (status !== undefined && status >= 400 && status <= 499) return "rejected";
	if (/invalid.{0,12}(?:api[_ -]?key|token)|unauthori[sz]ed|authentication.{0,12}(?:fail|error)|认证失败/i.test(error)) return "authentication";
	if (/rate.?limit|too many requests|限流/i.test(error)) return "throttled";
	if (/timed? out|timeout|超时/i.test(error)) return "deadline";
	if (/network.?error|connection.{0,12}(?:error|refused|lost|closed|reset)|fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|terminated|ended without|stream ended before|other side closed/i.test(error)) return "transport";
	if (/service.{0,32}unavailable|server.?error|internal.?error|overloaded|\b50[0-9]\b|\b529\b/i.test(error)) return "service";
	return "rejected";
}

function emptyMessage(model: Model<Api>): AssistantMessage {
	return { role: "assistant", content: [], provider: model.provider, api: model.api, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending", timestamp: Date.now() };
}

const AUTH_HEADERS = /^(authorization|x-api-key|api-key|x-goog-api-key)$/i;
function withoutKeyHeaders<T extends Record<string, string | null> | undefined>(headers: T): T {
	return (headers ? Object.fromEntries(Object.entries(headers).filter(([key]) => !AUTH_HEADERS.test(key))) : undefined) as T;
}

export interface PoolStreamObserver {
	/** Private liveness only: never forward failed attempt content into the Agent context. */
	progress?(): void;
	/** Preserve reported usage of a discarded attempt without exposing its content. */
	discarded?(message: AssistantMessage): void;
	switch?(event: { model: string; from: string; to: string; reason: PoolFailure | "unconfigured" }): void;
}

/**
 * Commit a complete assistant response once. Failed partial text/tool arguments stay
 * inside the attempt, so retries cannot execute or persist discarded tool calls.
 */
export function pooledStream(pool: AccountPool, underlying: StreamFunction<Api, SimpleStreamOptions>, env: Record<string, string | undefined> = process.env, observer: PoolStreamObserver = {}): StreamFunction<Api, SimpleStreamOptions> {
	return (model: Model<Api>, context: Context, options: SimpleStreamOptions = {}) => {
		const stream = createAssistantMessageEventStream();
		let diagnostic: NonNullable<AssistantMessage["diagnostics"]>[number] | undefined;
		const safeDetail = (text: string) => {
			const keys = [...pool.accounts.map(account => env[account.apiKeyEnv]), options.apiKey,
				...Object.entries(options.headers ?? {}).filter(([name]) => AUTH_HEADERS.test(name)).map(([, value]) => value),
				...Object.entries(model.headers ?? {}).filter(([name]) => AUTH_HEADERS.test(name)).map(([, value]) => value)]
				.filter((value): value is string => typeof value === "string" && value.length > 0)
				.flatMap(value => [value, value.trim()]).filter(Boolean).sort((a, b) => b.length - a.length);
			for (const key of keys) text = text.replaceAll(key, "[redacted]");
			return text.slice(0, 1024);
		};
		const finish = (code: string, message?: AssistantMessage, aborted = false) => {
			// Exact tokens deliberately do not match Pi's outer retry heuristics.
			const error = { ...(message ?? emptyMessage(model)), content: [], diagnostics: diagnostic ? [diagnostic] : undefined, rawStopReason: undefined,
				stopReason: aborted ? "aborted" as const : "error" as const, errorMessage: code };
			stream.push({ type: "error", reason: error.stopReason, error });
			stream.end();
		};
		void (async () => {
			try {
				if (`${model.provider}/${model.id}` !== pool.model) return finish("ACCOUNT_POOL_MODEL_MISMATCH");
				const idleMs = Number(env.CODEFLOW_ACCOUNT_POOL_TIMEOUT_MS ?? options.timeoutMs ?? 600_000);
				if (!Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > 2_147_483_647) return finish("ACCOUNT_POOL_CONFIGURATION_INVALID");
				const attempted = new Set<string>();
				let selected = currentPoolSelection(pool, env);
				let last: AssistantMessage | undefined;
				let unreportedFailure: AssistantMessage | undefined;
				while (attempted.size < pool.accounts.length && !attempted.has(selected.account_id)) {
					if (options.signal?.aborted) return finish("ACCOUNT_POOL_CANCELLED", last, true);
					const account = pool.accounts.find(value => value.id === selected.account_id);
					if (!account) return finish("ACCOUNT_POOL_CONFIGURATION_INVALID");
					attempted.add(account.id);
					const key = env[account.apiKeyEnv]?.trim();
					let reason: PoolFailure | "unconfigured" = "unconfigured";
					if (key) {
						if (unreportedFailure) {
							observer.discarded?.({ ...unreportedFailure, content: [], diagnostics: undefined, errorMessage: "ACCOUNT_POOL_REPLACED", rawStopReason: undefined });
							unreportedFailure = undefined;
						}
						let status: number | undefined;
						let hookFailed = false;
						let timedOut = false;
						const controller = new AbortController();
						const cancel = () => controller.abort(options.signal?.reason);
						options.signal?.addEventListener("abort", cancel, { once: true });
						let timer: ReturnType<typeof setTimeout>;
						const progress = () => {
							clearTimeout(timer);
							timer = setTimeout(() => { timedOut = true; controller.abort(); }, idleMs);
						};
						progress();
						const requestFetch = options.fetch ?? globalThis.fetch;
						const captureFetch = (async (...args: Parameters<typeof fetch>) => {
							const response = await requestFetch(...args);
							status = response.status;
							return response;
						}) as typeof fetch;
						try {
							const response = underlying({ ...model, headers: withoutKeyHeaders(model.headers) }, { ...context, messages: [...context.messages] }, {
								...options, apiKey: key, headers: withoutKeyHeaders(options.headers), fetch: captureFetch,
								signal: controller.signal, timeoutMs: idleMs,
								maxRetries: 0,
								onPayload: async (payload, requestModel) => {
									try { return await options.onPayload?.(payload, requestModel); } catch (error) { hookFailed = true; throw error; }
								},
								onResponse: async (response, requestModel) => {
									status = response.status;
									progress();
									try { await options.onResponse?.(response, requestModel); } catch (error) { hookFailed = true; throw error; }
								},
							});
							let terminal: AssistantMessage | undefined;
							for await (const event of response) {
								if (event.type === "done") terminal = event.message;
								else if (event.type === "error") terminal = event.error;
								else { progress(); observer.progress?.(); }
							}
							// A broken stream must not leave result() pending forever.
							last = terminal ?? { ...emptyMessage(model), stopReason: "error", errorMessage: "stream ended without a terminal event" };
						} catch (error) {
							last = { ...emptyMessage(model), stopReason: "error", errorMessage: error instanceof Error ? error.message : "provider failure" };
						} finally {
							clearTimeout(timer!);
							options.signal?.removeEventListener("abort", cancel);
						}
						if (options.signal?.aborted) return finish("ACCOUNT_POOL_CANCELLED", last, true);
						if (last.stopReason !== "error" && last.stopReason !== "aborted" && last.stopReason !== "pending") {
							stream.push({ type: "done", reason: last.stopReason, message: last }); stream.end(); return;
						}
						reason = hookFailed ? "rejected" : timedOut ? "deadline" : classifyPoolFailure(last, status, options.signal);
						diagnostic = { type: "account_pool_error", timestamp: Date.now(), error: { message: safeDetail(last.errorMessage ?? "Provider request failed") },
							details: { category: reason, ...(status === undefined ? {} : { http_status: status }) } };
						if (reason === "cancelled") return finish("ACCOUNT_POOL_CANCELLED", last, true);
						if (reason === "rejected") return finish("ACCOUNT_POOL_REQUEST_REJECTED", last);
						unreportedFailure = last;
					}
					if (options.signal?.aborted) return finish("ACCOUNT_POOL_CANCELLED", last, true);
					const next = await advancePoolAccount(pool, selected, env);
					observer.switch?.({ model: pool.model, from: selected.account_id, to: next.account_id, reason });
					selected = next;
				}
				finish("ACCOUNT_POOL_EXHAUSTED", last);
			} catch { finish("ACCOUNT_POOL_CONFIGURATION_INVALID"); }
		})();
		return stream;
	};
}
