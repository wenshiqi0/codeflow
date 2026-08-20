/**
 * In-process fake HuggingFace Hub — the offline counterpart for exercising
 * the PRODUCTION dataset fetch script `runtime/scripts/benchmark/hub-fetch.ts`
 * (fakes/README.md §5).
 *
 * Serves, on 127.0.0.1 only:
 *
 *   GET /api/datasets/<id>                       → { id, sha: <current head> }
 *   GET /splits?dataset=<id>&revision=<sha>      → { splits: [{config,split}…] }
 *   GET /rows?dataset=<id>&config&split&offset&length[&revision]
 *                                                → { rows: [{row,row_idx}…], num_rows_total }
 *
 * `/rows` mirrors real datasets-server semantics for exactly the race the
 * design forbids (§2): a request WITHOUT `revision` is served from the
 * CURRENT default-branch head, so an unpinned page silently follows a head
 * that moved mid-pagination. A request WITH `revision` is served from exactly
 * that dataset state; an unknown revision 404s loudly.
 *
 * Every request is recorded — method, path, query, the hub head at request
 * time, and the response status — so the pinning assertions can require that
 * the FIRST rows page and EVERY paginated follow-up carry the identical
 * resolved 40-hex sha. Not an executable fake: tests import and serve it
 * directly; it is never spawned.
 */

export interface FakeHubState {
	/** Dataset state key: a 40-hex revision sha (or, for alias-head tests, a movable alias). */
	revision: string;
	/** Full row records this state serves (evaluator-only fields included). */
	rows: Record<string, unknown>[];
}

export interface FakeHubRequest {
	seq: number;
	method: string;
	/** "/api/datasets/<id>" | "/splits" | "/rows" */
	path: string;
	query: Record<string, string>;
	/** The fake hub's default-branch head when this request arrived. */
	head: string;
	status: number;
}

export interface FakeHubOptions {
	/** The only hub id this fake serves; anything else 404s. */
	datasetId: string;
	/** At least one dataset state; states[0] is the initial head. */
	states: FakeHubState[];
	/**
	 * Maximum rows per /rows response regardless of the requested `length`
	 * (a server may always return fewer than asked). Default 2 — forces
	 * multi-page retrieval without large fixtures.
	 */
	maxPageLength?: number;
	/**
	 * Race simulation: after the Nth /rows response is served, move the
	 * default-branch head to `toRevision` — the dataset "moves" mid-pagination.
	 */
	moveHeadAfterRowsRequests?: { count: number; toRevision: string };
}

export interface FakeHub {
	/** For CODEFLOW_BENCHMARK_HUB_API_BASE (metadata API base). */
	apiBase: string;
	/** For CODEFLOW_BENCHMARK_HUB_SERVER_BASE (datasets-server base). */
	serverBase: string;
	/** Every request the fake served, in arrival order. */
	requests: FakeHubRequest[];
	head: () => string;
	setHead: (revision: string) => void;
	/** The recorded /rows requests, in arrival order. */
	rowsRequests: () => FakeHubRequest[];
	stop: () => void;
}

export function startFakeHub(options: FakeHubOptions): FakeHub {
	const states = options.states;
	if (states.length === 0) throw new Error("fake-hub: at least one state is required");
	let headRevision = states[0].revision;
	const maxPageLength = options.maxPageLength ?? 2;
	const requests: FakeHubRequest[] = [];
	let rowsServed = 0;

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request: Request): Response {
			const url = new URL(request.url);
			const query: Record<string, string> = Object.fromEntries(url.searchParams.entries());
			// The head when this request ARRIVED — recorded so tests can prove a
			// mid-pagination move happened between two pages, not while serving one.
			const headAtRequest = headRevision;
			let status = 404;
			let body: Record<string, unknown> = { error: `fake-hub: no route for ${url.pathname}` };

			const datasetMatch = url.pathname.match(/^\/api\/datasets\/(.+)$/);
			if (datasetMatch) {
				if (decodeURIComponent(datasetMatch[1]) !== options.datasetId) {
					status = 404;
					body = { error: `fake-hub: unknown dataset ${datasetMatch[1]}` };
				} else {
					status = 200;
					body = { id: options.datasetId, sha: headAtRequest };
				}
			} else if (url.pathname === "/splits") {
				if (query.dataset !== options.datasetId) {
					status = 404;
					body = { error: `fake-hub: unknown dataset ${String(query.dataset)}` };
				} else {
					status = 200;
					// "raw" serves only train — the fetcher must pick the test split's config.
					body = { splits: [{ config: "raw", split: "train" }, { config: "default", split: "test" }] };
				}
			} else if (url.pathname === "/rows") {
				// Default-branch semantics when `revision` is absent or empty:
				// the CURRENT head decides which dataset state answers.
				const requestedRevision = query.revision && query.revision !== "" ? query.revision : headAtRequest;
				const state = states.find((entry) => entry.revision === requestedRevision);
				if (query.dataset !== options.datasetId || query.split !== "test" || state === undefined) {
					status = 404;
					body = {
						error:
							`fake-hub /rows: not served (dataset=${String(query.dataset)} split=${String(query.split)} ` +
							`revision=${requestedRevision})`,
					};
				} else {
					const offset = Math.max(0, Number.parseInt(query.offset ?? "0", 10) || 0);
					const requestedLength = Math.max(1, Number.parseInt(query.length ?? "100", 10) || 100);
					const length = Math.min(requestedLength, maxPageLength, Math.max(0, state.rows.length - offset));
					const batch = state.rows.slice(offset, offset + length).map((row, index) => ({
						row,
						row_idx: offset + index,
					}));
					status = 200;
					body = { rows: batch, num_rows_total: state.rows.length };
					rowsServed += 1;
					const move = options.moveHeadAfterRowsRequests;
					if (move && rowsServed === move.count) headRevision = move.toRevision;
				}
			}

			requests.push({
				seq: requests.length + 1,
				method: request.method,
				path: url.pathname,
				query,
				head: headAtRequest,
				status,
			});
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	});

	return {
		apiBase: `http://127.0.0.1:${server.port}/api`,
		serverBase: `http://127.0.0.1:${server.port}`,
		requests,
		head: () => headRevision,
		setHead: (revision: string) => {
			headRevision = revision;
		},
		rowsRequests: () => requests.filter((entry) => entry.path === "/rows"),
		stop: () => {
			server.stop(true);
		},
	};
}
