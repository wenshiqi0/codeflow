/**
 * Monotonic sequence allocation for event delivery.
 *
 * The outer loop passes the highest sequence it has seen back as `--since`,
 * so two events sharing a number would silently hide one of them. Uniqueness
 * is therefore the property that matters, and it has to hold across separate
 * processes: delegated roles run as their own `pi` invocations and emit events
 * concurrently.
 *
 * The Python original took an `fcntl.flock` on a counter file. Bun has no
 * portable advisory lock, so this claims each number by exclusively creating
 * a marker file instead. `O_EXCL` create is atomic on every POSIX filesystem
 * and, unlike `flock`, on NFS too: exactly one racer can create a given name,
 * and the losers move on to the next number.
 *
 * Gaps are acceptable. The watermark is the largest sequence observed, never
 * "the next one expected", so a skipped number costs nothing. Trading
 * contiguity for lock-free correctness is the right way round — a duplicate
 * would lose an event, while a gap loses nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Where claim markers live, relative to the counter file. */
function claimDir(counterPath: string): string {
	return counterPath + ".d";
}

/**
 * Read the highest number claimed so far.
 *
 * The counter file is a hint, not the authority: it lets allocation start
 * near the top instead of walking from 1 as a run grows. A missing or corrupt
 * hint only costs a few extra probes.
 */
function readHint(counterPath: string): number {
	try {
		const raw = fs.readFileSync(counterPath, "utf-8").trim();
		const value = Number.parseInt(raw, 10);
		return Number.isSafeInteger(value) && value > 0 ? value : 0;
	} catch {
		return 0;
	}
}

/**
 * Claim and return the next unused sequence number.
 *
 * Concurrent callers never receive the same number: the winner of each
 * `O_EXCL` create keeps it and everyone else advances.
 */
export function nextSeq(counterPath: string): number {
	const claims = claimDir(counterPath);
	fs.mkdirSync(claims, { recursive: true });

	let candidate = readHint(counterPath) + 1;

	// Bounded so a corrupt hint or an exhausted filesystem fails loudly
	// rather than spinning forever.
	for (let attempt = 0; attempt < 100_000; attempt++) {
		try {
			// wx: create, fail if it exists. This is the claim.
			fs.writeFileSync(path.join(claims, String(candidate)), "", { flag: "wx" });

			// Publish the hint for the next caller. A lost race here is
			// harmless: the hint only has to be a lower bound, and the
			// markers remain the authority.
			try {
				const current = readHint(counterPath);
				if (candidate > current) {
					fs.writeFileSync(counterPath, String(candidate), "utf-8");
				}
			} catch {
				// An unwritable hint costs probes, not correctness.
			}

			return candidate;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST") {
				// Somebody else holds this number. Take the next one.
				candidate++;
				continue;
			}
			throw error;
		}
	}

	throw new Error(`could not allocate a sequence number under ${counterPath}`);
}
