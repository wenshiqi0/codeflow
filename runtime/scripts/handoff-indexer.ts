#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { runZipper } from "../extensions/bash-compressor/index";
import {
	applySemanticHandoffIndexCard,
	buildHandoffIndexCard,
	handoffIndexCardPath,
	semanticHandoffIndexPrompt,
	type HandoffIndexPhase,
} from "../lib/collaboration-index";
import { RunPaths, writeJsonAtomic } from "../lib/paths";

function value(flag: string): string {
	const index = process.argv.indexOf(flag);
	const next = index >= 0 ? process.argv[index + 1] : undefined;
	if (!next) throw new Error(`${flag} is required`);
	return next;
}

const handoffId = value("--id");
const phase = value("--phase") as HandoffIndexPhase;
const runId = process.env.CODEFLOW_RUN_ID ?? value("--run-id");
const runsDir = process.env.CODEFLOW_RUNS_DIR ?? value("--runs-dir");
const paths = new RunPaths(runsDir, runId);
const state = JSON.parse(fs.readFileSync(paths.statePath(handoffId), "utf8"));
const body = fs.readFileSync(path.join(paths.handoffDir(handoffId), "handoff.md"), "utf8");
const receiptFile = paths.receiptPath(handoffId);
const receipt = fs.existsSync(receiptFile)
	? JSON.parse(fs.readFileSync(receiptFile, "utf8")) as Record<string, unknown>
	: null;
const base = buildHandoffIndexCard(paths, state, phase);
const output = await runZipper(semanticHandoffIndexPrompt(base, body, receipt));
const semantic = applySemanticHandoffIndexCard(base, output);
writeJsonAtomic(handoffIndexCardPath(paths, handoffId, phase), semantic);
