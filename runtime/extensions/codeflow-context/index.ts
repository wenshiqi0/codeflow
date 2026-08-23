/** Assemble a fresh, Goal-scoped working set for every Handoff. */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadHandoff } from "../../lib/handoff";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import { buildWorkerContext } from "./context";

const CONTEXT_CUSTOM_TYPE = "codeflow:context";
const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readIfPresent(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const taskId = process.env.CODEFLOW_RUN_ID;
		const handoffId = process.env.CODEFLOW_HANDOFF_ID;
		if (!taskId || !handoffId) throw new Error("Codeflow Worker requires a task and current handoff");
		const paths = new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, taskId);
		const current = loadHandoff(paths, handoffId);
		const cwd = event.systemPromptOptions?.cwd || process.cwd();
		const block = buildWorkerContext(paths, current, {
			sharedRules: readIfPresent(path.join(RUNTIME_DIR, "AGENTS.md")),
			projectRules: readIfPresent(path.join(cwd, "AGENTS.md")),
		});
		return {
			message: {
				customType: CONTEXT_CUSTOM_TYPE,
				content: block.xml,
				display: true,
				details: { sources: block.sources },
			},
		};
	});

	// A Handoff must close with a Receipt or be re-grounded from durable state.
	// Silent conversation compaction would create an untracked continuation state.
	pi.on("session_before_compact", () => ({ cancel: true }));
}
