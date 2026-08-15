/**
 * Contract tests for the handoff state machine.
 *
 * These pin the guarantees the outer loop depends on: terminal states are
 * immutable, a delegated PASS needs a validated receipt, events are named so
 * the metadata plane works without reading bodies, and facts reach the ledger
 * only through a validated receipt.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	agentsList,
	BLOCKED_REASONS,
	CliError,
	finishHandoff,
	handoffList,
	handoffStatus,
	openHandoff,
	parseGoal,
	parseScope,
	runnerExited,
	runStart,
	startHandoff,
	TITLE_BUDGET,
} from "../../runtime/lib/handoff";
import { LEDGER_NAME, materialize } from "../../runtime/lib/facts";
import { RunPaths, readJson } from "../../runtime/lib/paths";

const RUN_ID = "run-test-0001";
const RUNS_DIR = ".codeflow/runs/code";

let dir: string;
let cwd: string;
let paths: RunPaths;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-handoff-"));
	cwd = process.cwd();
	process.chdir(dir);
	fs.mkdirSync("src");
	fs.writeFileSync("src/router.ts", "route()\n");
	fs.writeFileSync("src/config.ts", "loadConfig()\n");
	paths = new RunPaths(RUNS_DIR, RUN_ID);
});

afterEach(() => {
	process.chdir(cwd);
	fs.rmSync(dir, { recursive: true, force: true });
});

function open(role = "planner", depth = 0, body?: string) {
	return openHandoff(paths, {
		role,
		depth,
		body: body ?? "Goal: do the thing\nScope: src/router.ts\n",
	});
}

function receiptFile(name: string, payload: unknown): string {
	fs.writeFileSync(name, JSON.stringify(payload), "utf-8");
	return name;
}

function eventNames(): string[] {
	if (!fs.existsSync(paths.events)) return [];
	return fs.readdirSync(paths.events).sort();
}

describe("body parsing", () => {
	test("reads an inline goal", () => {
		expect(parseGoal("Goal: add a timeout")).toBe("add a timeout");
	});

	test("reads a goal under a heading", () => {
		expect(parseGoal("## Goal\n\nadd a timeout\n")).toBe("add a timeout");
	});

	test("strips list markers from a heading goal", () => {
		expect(parseGoal("# Goal\n- add a timeout\n")).toBe("add a timeout");
	});

	test("is case-insensitive", () => {
		expect(parseGoal("goal: lowercase")).toBe("lowercase");
	});

	test("returns empty when there is no goal", () => {
		expect(parseGoal("Scope: src/a.ts")).toBe("");
	});

	test("reads a comma-separated scope", () => {
		expect(parseScope("Scope: src/a.ts, src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("strips backticks and trailing prose punctuation from scope", () => {
		expect(parseScope("Scope: `src/a.ts`, src/b.ts.")).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("ignores scope words that are not paths", () => {
		expect(parseScope("Scope: everything in the repo")).toEqual([]);
	});
});

describe("open", () => {
	test("rejects an empty body", () => {
		expect(() => openHandoff(paths, { role: "planner", body: "   " })).toThrow(CliError);
	});

	test("allocates a role-tagged id", () => {
		expect(open("planner").handoff_id).toBe("h00001-planner");
	});

	test("ids increase within a run", () => {
		open("planner");
		expect(open("coder").handoff_id).toBe("h00002-coder");
	});

	test("writes the body verbatim", () => {
		const result = open("planner", 0, "Goal: keep this exact text\n");
		expect(fs.readFileSync(result.handoff_md, "utf-8")).toBe("Goal: keep this exact text\n");
	});

	test("extracts goal and scope into state", () => {
		const result = open();
		const state = readJson<any>(result.state);
		expect(state.goal).toBe("do the thing");
		expect(state.scope).toEqual(["src/router.ts"]);
	});

	test("starts open with an active sentinel", () => {
		const result = open();
		expect(readJson<any>(result.state).status).toBe("open");
		expect(fs.existsSync(path.join(paths.active, result.handoff_id))).toBe(true);
	});

	test("infers depth 1 from a parent", () => {
		const result = openHandoff(paths, {
			role: "coder",
			body: "Goal: implement\n",
			parentId: "h00001-planner",
		});
		expect(result.depth).toBe(1);
	});

	test("defaults to depth 0 without a parent", () => {
		expect(openHandoff(paths, { role: "planner", body: "Goal: plan\n" }).depth).toBe(0);
	});

	test("an explicit scope overrides the parsed one", () => {
		const result = openHandoff(paths, {
			role: "coder",
			body: "Goal: x\nScope: src/router.ts\n",
			scope: ["src/config.ts"],
		});
		expect(result.scope).toEqual(["src/config.ts"]);
	});

	test("emits a handoff_opened event", () => {
		open();
		expect(eventNames()).toEqual(["00001--h00001-planner--handoff_opened--OPEN.json"]);
	});

	test("an explicit title is stored", () => {
		const result = openHandoff(paths, { role: "planner", body: "Goal: x\n", title: "short title" });
		expect(fs.readFileSync(paths.titlePath(result.handoff_id), "utf-8").trim()).toBe("short title");
	});

	test("a title is capped to the budget", () => {
		const result = openHandoff(paths, {
			role: "planner",
			body: "Goal: x\n",
			title: "t".repeat(TITLE_BUDGET + 40),
		});
		expect(fs.readFileSync(paths.titlePath(result.handoff_id), "utf-8").trim().length).toBe(
			TITLE_BUDGET,
		);
	});
});

describe("scope conflicts", () => {
	test("overlapping active scope is reported", () => {
		open("test-writer", 1);
		const second = openHandoff(paths, {
			role: "coder",
			depth: 1,
			body: "Goal: x\nScope: src/router.ts\n",
		});
		expect(second.scope_conflicts).toEqual(["src/router.ts"]);
		expect(second.warning).toContain("h00001-test-writer");
	});

	test("a conflict is recorded but never blocks the open", () => {
		open("test-writer", 1);
		const second = openHandoff(paths, {
			role: "coder",
			depth: 1,
			body: "Goal: x\nScope: src/router.ts\n",
		});
		// Serializing is a planning decision, not a mechanical one.
		expect(readJson<any>(second.state).scope_conflicts).toEqual(["src/router.ts"]);
	});

	test("disjoint scope produces no conflict", () => {
		open("test-writer", 1);
		const second = openHandoff(paths, {
			role: "coder",
			depth: 1,
			body: "Goal: x\nScope: src/config.ts\n",
		});
		expect(second.scope_conflicts).toEqual([]);
	});

	test("a finished handoff no longer holds its scope", () => {
		const first = open("test-writer", 1);
		finishHandoff(paths, {
			handoffId: first.handoff_id,
			status: "PASS",
			summary: "done",
			receipt: receiptFile("r.json", { status: "PASS" }),
		});
		const second = openHandoff(paths, {
			role: "coder",
			depth: 1,
			body: "Goal: x\nScope: src/router.ts\n",
		});
		expect(second.scope_conflicts).toEqual([]);
	});
});

describe("start", () => {
	test("moves an open handoff to running", () => {
		const result = open();
		expect(startHandoff(paths, result.handoff_id).status).toBe("running");
	});

	test("records the pid", () => {
		const result = open();
		startHandoff(paths, result.handoff_id, 4242);
		expect(readJson<any>(result.state).pid).toBe(4242);
	});

	test("starting is idempotent and keeps the original timestamp", () => {
		const result = open();
		startHandoff(paths, result.handoff_id);
		const first = readJson<any>(result.state).started_at;
		startHandoff(paths, result.handoff_id);
		expect(readJson<any>(result.state).started_at).toBe(first);
	});

	test("starting a terminal handoff is an illegal transition", () => {
		const result = open();
		finishHandoff(paths, { handoffId: result.handoff_id, status: "PASS", summary: "done" });
		expect(() => startHandoff(paths, result.handoff_id)).toThrow(CliError);
	});

	test("an unknown handoff is rejected", () => {
		expect(() => startHandoff(paths, "h99999-ghost")).toThrow(CliError);
	});
});

describe("finish", () => {
	test("a depth-0 handoff may finish without a receipt", () => {
		// Nobody delegated it, so there is no delegator to prove anything to.
		const result = open();
		expect(
			finishHandoff(paths, { handoffId: result.handoff_id, status: "PASS", summary: "done" })
				.status,
		).toBe("PASS");
	});

	test("a delegated PASS requires a receipt", () => {
		const result = open("coder", 1);
		expect(() =>
			finishHandoff(paths, { handoffId: result.handoff_id, status: "PASS", summary: "done" }),
		).toThrow(CliError);
	});

	test("a delegated BLOCKED needs no receipt file", () => {
		// The reason enum is the receipt.
		const result = open("coder", 1);
		expect(
			finishHandoff(paths, {
				handoffId: result.handoff_id,
				status: "BLOCKED",
				summary: "stuck",
				blockedReasons: ["PROVIDER_FAILURE"],
			}).status,
		).toBe("BLOCKED");
	});

	test("a terminal receipt is immutable", () => {
		const result = open();
		finishHandoff(paths, { handoffId: result.handoff_id, status: "PASS", summary: "done" });
		expect(() =>
			finishHandoff(paths, { handoffId: result.handoff_id, status: "FAIL", summary: "again" }),
		).toThrow(CliError);
	});

	test("finishing clears the active sentinel", () => {
		const result = open();
		finishHandoff(paths, { handoffId: result.handoff_id, status: "PASS", summary: "done" });
		expect(fs.existsSync(path.join(paths.active, result.handoff_id))).toBe(false);
	});

	test("BLOCKED requires a reason", () => {
		const result = open();
		expect(() =>
			finishHandoff(paths, { handoffId: result.handoff_id, status: "BLOCKED", summary: "x" }),
		).toThrow(CliError);
	});

	test("a reason without BLOCKED is rejected", () => {
		const result = open();
		expect(() =>
			finishHandoff(paths, {
				handoffId: result.handoff_id,
				status: "PASS",
				summary: "x",
				blockedReasons: ["PROVIDER_FAILURE"],
			}),
		).toThrow(CliError);
	});

	test("an unknown blocked reason is rejected", () => {
		const result = open();
		expect(() =>
			finishHandoff(paths, {
				handoffId: result.handoff_id,
				status: "BLOCKED",
				summary: "x",
				blockedReasons: ["VIBES"],
			}),
		).toThrow(CliError);
	});

	test("several reasons may apply at once", () => {
		const result = open();
		finishHandoff(paths, {
			handoffId: result.handoff_id,
			status: "BLOCKED",
			summary: "x",
			blockedReasons: ["OUTPUT_TRUNCATED", "DELEGATION_ARTIFACT_MISSING"],
		});
		const state = readJson<any>(result.state);
		expect(state.blocked.reason).toBe("OUTPUT_TRUNCATED");
		expect(state.blocked.reasons).toHaveLength(2);
	});

	test("a budget reason carries the nested detail", () => {
		const result = open();
		finishHandoff(paths, {
			handoffId: result.handoff_id,
			status: "BLOCKED",
			summary: "x",
			blockedReasons: ["CONTEXT_BUDGET_EXCEEDED"],
			budget: { limit: 100, used: 120, remaining: -20 },
		});
		expect(readJson<any>(result.state).blocked.budget_failure.budget.used).toBe(120);
	});

	test("every blocked reason in the enum is accepted", () => {
		for (const reason of BLOCKED_REASONS) {
			const result = open("coder", 1);
			expect(
				finishHandoff(paths, {
					handoffId: result.handoff_id,
					status: "BLOCKED",
					summary: "x",
					blockedReasons: [reason],
				}).status,
			).toBe("BLOCKED");
		}
	});

	test("a declared artifact must exist", () => {
		const result = open();
		expect(() =>
			finishHandoff(paths, {
				handoffId: result.handoff_id,
				status: "PASS",
				summary: "done",
				artifacts: ["missing.patch"],
			}),
		).toThrow(CliError);
	});

	test("a declared artifact must be a non-empty file", () => {
		const result = open("coder", 1);
		fs.writeFileSync("unit-checkpoint.json", "");
		expect(() =>
			finishHandoff(paths, {
				handoffId: result.handoff_id,
				status: "PASS",
				summary: "done",
				receipt: receiptFile("r.json", { status: "PASS" }),
				artifacts: ["unit-checkpoint.json"],
			}),
		).toThrow(CliError);
	});

	test("an existing artifact emits its own event", () => {
		const result = open();
		fs.writeFileSync("tests.patch", "diff\n");
		finishHandoff(paths, {
			handoffId: result.handoff_id,
			status: "PASS",
			summary: "done",
			artifacts: ["tests.patch"],
		});
		expect(eventNames().some((name) => name.includes("artifact_written"))).toBe(true);
	});

	test("the root handoff finishing ends the run", () => {
		const result = open();
		finishHandoff(paths, { handoffId: result.handoff_id, status: "PASS", summary: "done" });
		expect(eventNames().some((name) => name.includes("run_finished"))).toBe(true);
	});

	test("a child finishing does not end the run", () => {
		const child = openHandoff(paths, {
			role: "coder",
			body: "Goal: x\n",
			parentId: "h00001-planner",
		});
		finishHandoff(paths, {
			handoffId: child.handoff_id,
			status: "PASS",
			summary: "done",
			receipt: receiptFile("r.json", { status: "PASS" }),
		});
		expect(eventNames().some((name) => name.includes("run_finished"))).toBe(false);
	});

	test("a handoff-less planner's delegations never end the run", () => {
		// Incident reproduction: codeflow-task opens every delegation with
		// parentId: process.env.CODEFLOW_HANDOFF_ID ?? null and depth: 1. A
		// depth-0 planner started directly has no handoff id, so its children
		// are recorded parentless at depth 1 — and a depth-1 finish must still
		// not end the run, because the planner above them is the run's root
		// even when it holds no handoff id itself.
		const saved = process.env.CODEFLOW_HANDOFF_ID;
		delete process.env.CODEFLOW_HANDOFF_ID;
		try {
			const openDelegation = (role: string) => {
				const result = openHandoff(paths, {
					role,
					depth: 1,
					parentId: process.env.CODEFLOW_HANDOFF_ID ?? null,
					body: "Goal: x\n",
				});
				// Prove the precondition: these delegations really are parentless.
				expect(readJson<any>(result.state).lineage.parent_handoff_id).toBe(null);
				return result;
			};
			const passed = openDelegation("test-writer");
			const failed = openDelegation("coder");
			const blocked = openDelegation("verifier");

			finishHandoff(paths, {
				handoffId: passed.handoff_id,
				status: "PASS",
				summary: "done",
				receipt: receiptFile("pass.json", { status: "PASS" }),
			});
			finishHandoff(paths, {
				handoffId: failed.handoff_id,
				status: "FAIL",
				summary: "nope",
				receipt: receiptFile("fail.json", { status: "FAIL" }),
			});
			finishHandoff(paths, {
				handoffId: blocked.handoff_id,
				status: "BLOCKED",
				summary: "stuck",
				blockedReasons: ["PROVIDER_FAILURE"],
			});

			// All three finishes landed, so the run_finished assertions below
			// are not vacuous.
			expect(eventNames().filter((name) => name.includes("handoff_finished"))).toHaveLength(3);
			expect(eventNames().some((name) => name.includes("run_finished"))).toBe(false);
			const spoolNames = fs.existsSync(paths.spool) ? fs.readdirSync(paths.spool) : [];
			expect(spoolNames.some((name) => name.includes("run_finished"))).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.CODEFLOW_HANDOFF_ID;
			else process.env.CODEFLOW_HANDOFF_ID = saved;
		}
	});

	test("the root handoff finishing emits exactly one run_finished", () => {
		// One run, one ending: a duplicate run_finished would double-count the
		// run in the metadata plane.
		const result = open();
		finishHandoff(paths, { handoffId: result.handoff_id, status: "PASS", summary: "done" });
		expect(eventNames().filter((name) => name.includes("run_finished"))).toHaveLength(1);
	});

	test("a parented handoff never ends the run, even at depth 0", () => {
		// Defensive combination: depth says root, lineage says child. The
		// parent link must win — somebody delegated this work, so its finish
		// is not the run's end.
		const child = openHandoff(paths, {
			role: "coder",
			depth: 0,
			parentId: "h00001-planner",
			body: "Goal: x\n",
		});
		finishHandoff(paths, { handoffId: child.handoff_id, status: "PASS", summary: "done" });
		expect(eventNames().some((name) => name.includes("run_finished"))).toBe(false);
	});
});

describe("receipt validation", () => {
	function finishWith(payload: unknown, role = "coder") {
		const result = open(role, 1);
		return () =>
			finishHandoff(paths, {
				handoffId: result.handoff_id,
				status: "PASS",
				summary: "done",
				receipt: receiptFile("r.json", payload),
			});
	}

	test("prose is not a receipt", () => {
		const result = open("coder", 1);
		fs.writeFileSync("r.txt", "I finished the work", "utf-8");
		expect(() =>
			finishHandoff(paths, {
				handoffId: result.handoff_id,
				status: "PASS",
				summary: "done",
				receipt: "r.txt",
			}),
		).toThrow(CliError);
	});

	test("a missing receipt file is rejected", () => {
		const result = open("coder", 1);
		expect(() =>
			finishHandoff(paths, {
				handoffId: result.handoff_id,
				status: "PASS",
				summary: "done",
				receipt: "absent.json",
			}),
		).toThrow(CliError);
	});

	test("a receipt status contradicting the declared status is rejected", () => {
		expect(finishWith({ status: "FAIL" })).toThrow(CliError);
	});

	test("test-runner must supply command and exit_code", () => {
		expect(finishWith({ status: "PASS" }, "test-runner")).toThrow(CliError);
	});

	test("test-runner with full evidence is accepted", () => {
		expect(
			finishWith({ status: "PASS", command: "bun test", exit_code: 0 }, "test-runner"),
		).not.toThrow();
	});

	test("a mistyped field is rejected", () => {
		expect(finishWith({ status: "PASS", exit_code: "zero" })).toThrow(CliError);
	});

	test("a mistyped array field is rejected", () => {
		expect(finishWith({ status: "PASS", failed_checks: "one" })).toThrow(CliError);
	});

	test("an empty batch is rejected", () => {
		expect(finishWith({ status: "PASS", receipts: [] })).toThrow(CliError);
	});

	test("a batch validates every entry", () => {
		expect(
			finishWith({
				status: "PASS",
				receipts: [{ status: "PASS" }, { status: "nonsense" }],
			}),
		).toThrow(CliError);
	});

	test("a long excerpt spills to evidence and keeps a reference", () => {
		const result = open("test-runner", 1);
		finishHandoff(paths, {
			handoffId: result.handoff_id,
			status: "FAIL",
			summary: "failed",
			receipt: receiptFile("r.json", {
				status: "FAIL",
				command: "bun test",
				exit_code: 1,
				error_excerpt: "x".repeat(5000),
			}),
		});
		const state = readJson<any>(result.state);
		expect(state.evidence_refs).toHaveLength(1);
		expect(fs.existsSync(path.join(paths.runsRoot, state.evidence_refs[0]))).toBe(true);
	});
});

describe("facts recorded through receipts", () => {
	test("receipt facts reach the ledger", () => {
		const result = open("planner", 0);
		finishHandoff(paths, {
			handoffId: result.handoff_id,
			status: "PASS",
			summary: "done",
			receipt: receiptFile("r.json", {
				status: "PASS",
				facts: [{ claim: "entry", path: "src/router.ts", line: 1 }],
			}),
		});
		expect(materialize(path.join(paths.runDir, LEDGER_NAME))).toHaveLength(1);
	});

	test("recorded ids are reported back", () => {
		const result = open();
		const finished = finishHandoff(paths, {
			handoffId: result.handoff_id,
			status: "PASS",
			summary: "done",
			receipt: receiptFile("r.json", {
				status: "PASS",
				facts: [{ claim: "a", value: "1" }],
			}),
		});
		expect(finished.facts_recorded).toEqual(["f1"]);
	});

	test("an unverifiable fact rejects the whole finish", () => {
		const result = open();
		expect(() =>
			finishHandoff(paths, {
				handoffId: result.handoff_id,
				status: "PASS",
				summary: "done",
				receipt: receiptFile("r.json", {
					status: "PASS",
					facts: [{ claim: "ghost", path: "src/absent.ts" }],
				}),
			}),
		).toThrow(CliError);
	});

	test("a rejected finish leaves the handoff open", () => {
		const result = open();
		try {
			finishHandoff(paths, {
				handoffId: result.handoff_id,
				status: "PASS",
				summary: "done",
				receipt: receiptFile("r.json", {
					status: "PASS",
					facts: [{ claim: "ghost", path: "src/absent.ts" }],
				}),
			});
		} catch {
			// expected
		}
		expect(readJson<any>(result.state).status).toBe("open");
	});

	test("facts are attributed to the finishing role", () => {
		const result = open("test-writer", 1);
		finishHandoff(paths, {
			handoffId: result.handoff_id,
			status: "PASS",
			summary: "done",
			receipt: receiptFile("r.json", {
				status: "PASS",
				facts: [{ claim: "vitest", value: "vitest" }],
			}),
		});
		expect(materialize(path.join(paths.runDir, LEDGER_NAME))[0].role).toBe("test-writer");
	});

	test("a BLOCKED finish without a receipt records nothing", () => {
		const result = open();
		finishHandoff(paths, {
			handoffId: result.handoff_id,
			status: "BLOCKED",
			summary: "stuck",
			blockedReasons: ["PROVIDER_FAILURE"],
		});
		expect(fs.existsSync(path.join(paths.runDir, LEDGER_NAME))).toBe(false);
	});
});

describe("queries", () => {
	test("status of one handoff returns its state", () => {
		const result = open();
		expect((handoffStatus(paths, result.handoff_id) as any).handoff_id).toBe(result.handoff_id);
	});

	test("status without an id returns active handoffs", () => {
		open("planner");
		open("coder", 1);
		expect(handoffStatus(paths)).toHaveLength(2);
	});

	test("an in-flight handoff reports its age", () => {
		const result = open();
		expect((handoffStatus(paths, result.handoff_id) as any).age_seconds).toBeGreaterThanOrEqual(0);
	});

	test("stale is an age, not a verdict", () => {
		const result = open();
		const state = handoffStatus(paths, result.handoff_id) as any;
		// A fresh handoff is never stale; the flag only crosses a threshold.
		expect(state.stale).toBe(false);
	});

	test("a terminal handoff carries no age", () => {
		const result = open();
		finishHandoff(paths, { handoffId: result.handoff_id, status: "PASS", summary: "done" });
		expect((handoffStatus(paths, result.handoff_id) as any).age_seconds).toBeUndefined();
	});

	test("list reports result for a finished handoff", () => {
		const result = open();
		finishHandoff(paths, { handoffId: result.handoff_id, status: "PASS", summary: "done" });
		expect(handoffList(paths)[0].result).toBe("PASS");
	});

	test("list reports the blocked reason as the result", () => {
		const result = open();
		finishHandoff(paths, {
			handoffId: result.handoff_id,
			status: "BLOCKED",
			summary: "x",
			blockedReasons: ["PROVIDER_FAILURE"],
		});
		expect(handoffList(paths)[0].result).toBe("PROVIDER_FAILURE");
	});

	test("list uses the goal as a title", () => {
		open();
		expect(handoffList(paths)[0].title).toBe("do the thing");
	});

	test("an overlong goal is truncated for the title", () => {
		open("planner", 0, `Goal: ${"g".repeat(TITLE_BUDGET + 40)}\n`);
		expect((handoffList(paths)[0].title as string).length).toBeLessThanOrEqual(TITLE_BUDGET);
	});

	test("a compressed title wins over the goal", () => {
		const result = open();
		fs.writeFileSync(paths.titlePath(result.handoff_id), "compressed title\n", "utf-8");
		expect(handoffList(paths)[0].title).toBe("compressed title");
	});

	test("querying an unknown handoff is rejected", () => {
		expect(() => handoffStatus(paths, "h99999-ghost")).toThrow(CliError);
	});

	test("a malformed state file does not break the board", () => {
		open();
		const second = open("coder", 1);
		fs.writeFileSync(second.state, "{ not json", "utf-8");
		expect(handoffList(paths)).toHaveLength(1);
	});
});

describe("run lifecycle", () => {
	test("run-start writes runner.json and emits run_started", () => {
		runStart(paths, "planner", 1234);
		expect(fs.existsSync(path.join(paths.runDir, "runner.json"))).toBe(true);
		expect(eventNames().some((name) => name.includes("run_started"))).toBe(true);
	});

	test("run events also reach the shared spool", () => {
		runStart(paths, "planner", 1234);
		expect(fs.readdirSync(paths.spool).some((name) => name.includes("run_started"))).toBe(true);
	});

	test("a depth-0 exit is published", () => {
		// Nobody else is left to report that the execute loop stopped.
		expect(runnerExited(paths, 4242, "planner", 0).event).not.toBeNull();
		expect(eventNames().some((name) => name.includes("runner_exited"))).toBe(true);
	});

	test("a depth-0 exit mechanically closes an abandoned root handoff", () => {
		const root = open();
		const child = open("coder", 1);
		runnerExited(paths, 4242, "planner", 0);
		const state = readJson<any>(root.state);
		const childState = readJson<any>(child.state);
		const names = eventNames();

		expect(state.status).toBe("blocked");
		expect(state.blocked.reasons).toContain("DELEGATION_ARTIFACT_MISSING");
		expect(childState.status).toBe("blocked");
		const childFinishedAt = names.findIndex((name) => name.includes("h00002-coder--handoff_finished--BLOCKED"));
		const finishedAt = names.findIndex((name) => name.includes("run_finished--BLOCKED"));
		const exitedAt = names.findIndex((name) => name.includes("runner_exited--EXITED"));
		expect(childFinishedAt).toBeGreaterThanOrEqual(0);
		expect(finishedAt).toBeGreaterThanOrEqual(0);
		expect(finishedAt).toBeGreaterThan(childFinishedAt);
		expect(exitedAt).toBeGreaterThan(finishedAt);
	});

	test("a depth-0 exit does not duplicate a root terminal event", () => {
		const root = open();
		finishHandoff(paths, { handoffId: root.handoff_id, status: "PASS", summary: "done" });
		const before = eventNames().filter((name) => name.includes("run_finished")).length;
		runnerExited(paths, 4242, "planner", 0);
		const after = eventNames().filter((name) => name.includes("run_finished")).length;
		expect(after).toBe(before);
	});

	test("a depth-1 exit is recorded but not published", () => {
		// The parent delegation already observed it; publishing would be noise
		// the outer loop could mistake for a stop signal.
		expect(runnerExited(paths, 4243, "coder", 1).event).toBeNull();
		expect(eventNames().some((name) => name.includes("runner_exited"))).toBe(false);
	});

	test("an exit is always recorded in liveness", () => {
		runnerExited(paths, 4243, "coder", 1);
		expect(fs.readdirSync(paths.liveness)).toContain("4243--coder--1.json");
	});
});

describe("agents list", () => {
	test("is empty for a fresh run", () => {
		expect(agentsList(paths)).toEqual([]);
	});

	test("reports an active handoff", () => {
		const result = open("planner");
		startHandoff(paths, result.handoff_id, 111);
		const rows = agentsList(paths);
		expect(rows).toHaveLength(1);
		expect(rows[0].role).toBe("planner");
		expect(rows[0].handoff_id).toBe(result.handoff_id);
	});

	test("a finished handoff leaves the board", () => {
		const result = open();
		finishHandoff(paths, { handoffId: result.handoff_id, status: "PASS", summary: "done" });
		expect(agentsList(paths)).toEqual([]);
	});

	test("rows sort by depth then role", () => {
		const child = openHandoff(paths, { role: "test-writer", depth: 1, body: "Goal: x\n" });
		open("planner", 0);
		expect(agentsList(paths).map((row) => row.depth)).toEqual([0, 1]);
	});

	test("an exited heartbeat is not shown as alive", () => {
		runnerExited(paths, 999, "coder", 1);
		expect(agentsList(paths)).toEqual([]);
	});
});
