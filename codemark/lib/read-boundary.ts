/** Canonical repository boundary shared by Manager reads and context injection. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === ""
		|| (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function requestedPath(rawPath: string, cwd: string): string | null {
	try {
		const normalizedSpaces = rawPath.replace(UNICODE_SPACES, " ");
		const withoutAt = normalizedSpaces.startsWith("@") ? normalizedSpaces.slice(1) : normalizedSpaces;
		const expanded = withoutAt === "~"
			? os.homedir()
			: withoutAt.startsWith(`~${path.sep}`)
				? path.join(os.homedir(), withoutAt.slice(2))
				: withoutAt;
		const local = /^file:\/\//.test(expanded) ? fileURLToPath(expanded) : expanded;
		return path.resolve(cwd, local);
	} catch {
		return null;
	}
}

/**
 * Resolve one read once, following symlinks, and admit it only when the final
 * canonical target stays inside the measured repository and outside private run state.
 * Missing paths fail closed so Pi's alternate Unicode probes cannot escape the
 * path that was checked.
 */
export function allowedCodemarkReadTarget(
	rawPath: string,
	cwd: string,
	repository: string,
	privateRunDir?: string,
): string | null {
	const requested = requestedPath(rawPath, cwd);
	if (requested === null) return null;
	let canonicalTarget: string;
	let canonicalRepository: string;
	try {
		canonicalTarget = fs.realpathSync(requested);
		canonicalRepository = fs.realpathSync(repository);
	} catch {
		return null;
	}
	if (
		within("/proc", requested)
		|| within("/proc", canonicalTarget)
		|| within("/dev/fd", requested)
		|| within("/dev/fd", canonicalTarget)
		|| ["/dev/stdin", "/dev/stdout", "/dev/stderr"].includes(requested)
		|| ["/dev/stdin", "/dev/stdout", "/dev/stderr"].includes(canonicalTarget)
	) return null;
	if (!within(canonicalRepository, canonicalTarget)) return null;
	if (privateRunDir !== undefined) {
		try {
			if (within(fs.realpathSync(privateRunDir), canonicalTarget)) return null;
		} catch {
			return null;
		}
	}
	return canonicalTarget;
}
