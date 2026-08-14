"""Contract tests for the receipt -> fact-ledger path.

Facts reach the ledger only as a side effect of finishing a handoff with a
validated receipt. That keeps the ledger on the mechanical plane: there is no
second, model-driven write path that bypasses the CLI.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "runtime" / "skills" / "write-handoff" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import facts  # noqa: E402
import handoff_state  # noqa: E402


class HandoffFactsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._cwd = os.getcwd()
        os.chdir(self.root)
        Path("src").mkdir()
        Path("src/router.ts").write_text("route()\n", encoding="utf-8")
        self.runs_dir = ".codeflow/runs/code"
        self.run_id = "run-test-0001"

    def tearDown(self):
        os.chdir(self._cwd)
        self._tmp.cleanup()

    # --- helpers -------------------------------------------------------

    def cli(self, argv):
        return handoff_state.main(argv + ["--run-id", self.run_id, "--runs-dir", self.runs_dir])

    def open_handoff(self, role="planner", depth="0"):
        body = self.root / f"body-{role}.md"
        body.write_text("Goal: do the thing\n", encoding="utf-8")
        argv = [
            "handoff", "open", "--role", role, "--depth", depth,
            "--body-file", str(body),
            "--run-id", self.run_id, "--runs-dir", self.runs_dir,
        ]
        import contextlib
        import io
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            self.assertEqual(0, handoff_state.main(argv))
        return json.loads(buffer.getvalue())["handoff_id"]

    def receipt(self, name, payload):
        path = self.root / name
        path.write_text(json.dumps(payload), encoding="utf-8")
        return str(path)

    def finish(self, handoff_id, receipt_path, status="PASS"):
        import contextlib
        import io
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = self.cli(
                [
                    "handoff", "finish", "--id", handoff_id, "--status", status,
                    "--summary", "done", "--receipt", receipt_path,
                ]
            )
        return code, buffer.getvalue()

    @property
    def ledger(self):
        return Path(self.runs_dir) / self.run_id / facts.LEDGER_NAME

    # --- the happy path -------------------------------------------------

    def test_receipt_facts_land_in_the_run_ledger(self):
        handoff_id = self.open_handoff()
        path = self.receipt(
            "r.json",
            {
                "status": "PASS",
                "facts": [
                    {"claim": "route registration entry", "path": "src/router.ts", "line": 42},
                ],
            },
        )
        code, _ = self.finish(handoff_id, path)
        self.assertEqual(0, code)
        view = facts.materialize(self.ledger)
        self.assertEqual(["route registration entry"], [entry["claim"] for entry in view])

    def test_recorded_facts_are_attributed_to_the_finishing_role(self):
        handoff_id = self.open_handoff(role="test-writer", depth="1")
        path = self.receipt(
            "r.json",
            {"status": "PASS", "facts": [{"claim": "vitest", "value": "vitest"}]},
        )
        self.finish(handoff_id, path)
        self.assertEqual("test-writer", facts.materialize(self.ledger)[0]["role"])
        self.assertEqual(handoff_id, facts.materialize(self.ledger)[0]["handoff_id"])

    def test_a_receipt_without_facts_is_still_valid(self):
        """Most handoffs confirm nothing worth passing on."""
        handoff_id = self.open_handoff()
        path = self.receipt("r.json", {"status": "PASS"})
        code, _ = self.finish(handoff_id, path)
        self.assertEqual(0, code)
        self.assertFalse(self.ledger.exists())

    def test_facts_accumulate_across_handoffs_in_one_run(self):
        first = self.open_handoff(role="planner")
        self.finish(
            first,
            self.receipt("a.json", {"status": "PASS", "facts": [{"claim": "a", "value": "1"}]}),
        )
        second = self.open_handoff(role="coder", depth="1")
        self.finish(
            second,
            self.receipt("b.json", {"status": "PASS", "facts": [{"claim": "b", "value": "2"}]}),
        )
        self.assertEqual(["a", "b"], [entry["claim"] for entry in facts.materialize(self.ledger)])

    def test_a_later_role_can_correct_an_earlier_fact(self):
        first = self.open_handoff(role="planner")
        self.finish(
            first,
            self.receipt(
                "a.json",
                {"status": "PASS", "facts": [{"claim": "entry", "path": "src/router.ts"}]},
            ),
        )
        Path("src/routes.ts").write_text("route()\n", encoding="utf-8")
        second = self.open_handoff(role="coder", depth="1")
        self.finish(
            second,
            self.receipt(
                "b.json",
                {
                    "status": "PASS",
                    "facts": [
                        {
                            "supersedes": "f1",
                            "claim": "entry",
                            "path": "src/routes.ts",
                            "reason": "router was split during implementation",
                        }
                    ],
                },
            ),
        )
        view = facts.materialize(self.ledger)
        self.assertEqual(1, len(view))
        self.assertEqual("src/routes.ts", view[0]["path"])

    # --- failure modes --------------------------------------------------

    def test_an_unverifiable_fact_rejects_the_whole_finish(self):
        """Better a loud failure than a ledger nobody can trust."""
        handoff_id = self.open_handoff()
        path = self.receipt(
            "r.json",
            {"status": "PASS", "facts": [{"claim": "ghost", "path": "src/absent.ts"}]},
        )
        code, _ = self.finish(handoff_id, path)
        self.assertEqual(1, code)

    def test_a_rejected_finish_leaves_the_handoff_open(self):
        handoff_id = self.open_handoff()
        path = self.receipt(
            "r.json",
            {"status": "PASS", "facts": [{"claim": "ghost", "path": "src/absent.ts"}]},
        )
        self.finish(handoff_id, path)
        state = json.loads(
            (Path(self.runs_dir) / self.run_id / "handoffs" / handoff_id / "state.json").read_text()
        )
        self.assertNotIn(state["status"], ("done", "blocked"))

    def test_facts_must_be_an_array(self):
        handoff_id = self.open_handoff()
        path = self.receipt("r.json", {"status": "PASS", "facts": {"claim": "x"}})
        code, _ = self.finish(handoff_id, path)
        self.assertEqual(1, code)

    def test_a_blocked_handoff_without_a_receipt_records_no_facts(self):
        handoff_id = self.open_handoff()
        import contextlib
        import io
        with contextlib.redirect_stdout(io.StringIO()):
            code = self.cli(
                [
                    "handoff", "finish", "--id", handoff_id, "--status", "BLOCKED",
                    "--summary", "stuck", "--blocked-reason", "PROVIDER_FAILURE",
                ]
            )
        self.assertEqual(0, code)
        self.assertFalse(self.ledger.exists())

    def test_ledger_stays_inside_its_own_run(self):
        handoff_id = self.open_handoff()
        self.finish(
            handoff_id,
            self.receipt("r.json", {"status": "PASS", "facts": [{"claim": "a", "value": "1"}]}),
        )
        self.assertTrue(self.ledger.is_file())
        self.assertEqual(self.run_id, self.ledger.parent.name)


if __name__ == "__main__":
    unittest.main()
