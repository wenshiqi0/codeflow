/** Local HTTP/SSE fixture: exercises the installed Pi SDK without a paid API. */
export interface PoolRequest {
	account: string;
	body: { model: string; messages: Array<Record<string, any>>; [key: string]: unknown };
}

export function completion(text = "POOL_OK", tool?: { id: string; command: string }): Response {
	const chunks = [
		{ choices: [{ index: 0, delta: { role: "assistant", ...(tool ? {} : { content: text }) }, finish_reason: null }] },
		...(tool ? [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: tool.id, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: tool.command }) } }] }, finish_reason: null }] }] : []),
		{ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
	];
	return sse(chunks);
}

export function sse(chunks: unknown[]): Response {
	const body = chunks.map(chunk => `data: ${JSON.stringify({ id: "pool-fixture", object: "chat.completion.chunk", model: "fixed-model", ...chunk as object })}\n\n`).join("") + "data: [DONE]\n\n";
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export function apiFailure(status: number, message = "fixture service failure", type = "api_error"): Response {
	return Response.json({ error: { message, type } }, { status });
}

export function anthropicCompletion(): Response {
	const events = [
		{ type: "message_start", message: { id: "fixture-anthropic", type: "message", role: "assistant", model: "fixed-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "POOL_OK" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

export function poolServer(respond: (request: PoolRequest, index: number) => Response | Promise<Response>) {
	const requests: PoolRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			if (!["/v1/chat/completions", "/v1/messages"].includes(new URL(request.url).pathname)) return new Response("unexpected fixture path", { status: 404 });
			const account = (request.headers.get("x-api-key") ?? request.headers.get("authorization") ?? "").replace(/^(?:Bearer )?fixture-key-/, "");
			const row = { account, body: await request.json() } as PoolRequest;
			requests.push(row);
			return await respond(row, requests.length - 1);
		},
	});
	return { requests, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}
