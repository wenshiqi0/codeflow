#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";

interface DriverStep {
	event?: unknown;
	write?: Record<string, string>;
}

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const workspace = argValue("--workspace");
if (!workspace) process.exit(2);
const stdin = await new Response(Bun.stdin.stream()).text();
const instance = JSON.parse(stdin) as { instance_id: string };
const script = JSON.parse(fs.readFileSync(process.env.FAKE_DRIVER_SCRIPT!, "utf8")) as {
	instances: Record<string, { steps: DriverStep[] }>;
};

const capture = process.env.FAKE_CAPTURE_DIR;
if (capture) {
	fs.mkdirSync(capture, { recursive: true });
	fs.writeFileSync(path.join(capture, `driver-spawn-${process.pid}.json`), JSON.stringify({
		argv: process.argv.slice(2),
		stdin,
		workspace,
	}));
}

for (const step of script.instances[instance.instance_id]?.steps ?? []) {
	if (step.event !== undefined) process.stdout.write(`${JSON.stringify(step.event)}\n`);
	for (const [relative, content] of Object.entries(step.write ?? {})) {
		const target = path.join(workspace, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
}
