/**
 * In-process loopback hit recorders for the tool-network wall tests
 * (tests/benchmark/tool-network-wall.test.ts; fakes/README.md §6).
 *
 * Two stand-ins make the two networks of design §4 separable on one host,
 * fully offline:
 *
 *  - the "internet" recorder is addressed as `http://127.0.0.1:<port>/` —
 *    a plain loopback address that is NOT a configured provider endpoint;
 *  - the "provider" recorder is addressed as `http://localhost:<port>/` —
 *    the host name the run's model-provider endpoint resolves through (the
 *    tests wire MEROUTER_BASE_URL, the runtime's env-configured provider
 *    seam, to this URL).
 *
 * Both bind 127.0.0.1 (port 0), so no real network is ever touched; the ONLY
 * thing distinguishing them is the host name a client uses — which is
 * exactly what an egress wall's provider exemption matches against. A wall
 * may exempt the configured provider endpoint (localhost) without exempting
 * every loopback address (127.0.0.1); the tests assert both directions.
 *
 * Not an executable fake: tests import and serve it directly.
 */

export interface NetHit {
	seq: number;
	/** Request path, which the probes tag (root/delegated/control). */
	path: string;
	/** Host name the client actually used ("127.0.0.1" | "localhost"). */
	host: string;
}

export interface NetRecorder {
	/** Base URL with trailing slash; append a path tag per probe. */
	url: string;
	/** Every request served, in arrival order. */
	hits: NetHit[];
	/** Served request paths, in arrival order. */
	paths: () => string[];
	stop: () => void;
}

export function startNetRecorder(kind: "internet" | "provider" | "evaluator"): NetRecorder {
	const hits: NetHit[] = [];
	const urlHost = kind === "provider" ? "localhost" : "127.0.0.1";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request: Request): Response {
			const url = new URL(request.url);
			hits.push({ seq: hits.length + 1, path: url.pathname, host: url.hostname });
			return new Response(`netwall-${kind}`, { status: 200 });
		},
	});
	return {
		url: `http://${urlHost}:${server.port}/`,
		hits,
		paths: () => hits.map((hit) => hit.path),
		stop: () => {
			server.stop(true);
		},
	};
}
