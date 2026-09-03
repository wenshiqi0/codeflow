/** Inject the same model-visible bootstrap context as a fresh Codeflow Root. */

import * as fs from "node:fs";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildFreshRootContext } from "../../../runtime/extensions/codeflow-context/context";
import { readInitialOrganization } from "../../lib/organization";
import { allowedCodemarkReadTarget } from "../../lib/read-boundary";

const CONTEXT_CUSTOM_TYPE = "codeflow:context";

function projectRules(cwd: string, repository: string, runDir: string): string {
	const allowed = allowedCodemarkReadTarget("AGENTS.md", cwd, repository, runDir);
	return allowed === null ? "" : fs.readFileSync(allowed, "utf8");
}

export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		const runDir = process.env.CODEMARK_RUN_DIR;
		if (!runDir) throw new Error("context requires a run directory");
		const organization = readInitialOrganization(runDir);
		const cwd = event.systemPromptOptions?.cwd || process.cwd();
		const block = buildFreshRootContext(
			organization.root_goal.goal_id,
			organization.root_goal.objective,
			{ projectRules: projectRules(cwd, organization.repository, runDir) },
		);
		return {
			message: {
				customType: CONTEXT_CUSTOM_TYPE,
				content: block.xml,
				display: true,
				details: { sources: block.sources, shape: block.shape },
			},
		};
	});
}
