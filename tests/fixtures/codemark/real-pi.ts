#!/usr/bin/env bun
/** Add the offline provider fixture, then execute the repository's real Pi CLI. */

import * as path from "node:path";

const repository = path.resolve(import.meta.dir, "..", "..", "..");
const cli = path.join(
	repository,
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"dist",
	"cli.js",
);
const provider = path.join(import.meta.dir, "offline-provider.ts");
const child = Bun.spawn([
	process.execPath,
	cli,
	...process.argv.slice(2),
	"--extension",
	provider,
], {
	cwd: process.cwd(),
	env: process.env,
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});

process.exit(await child.exited);
