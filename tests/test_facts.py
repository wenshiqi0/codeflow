"""Contract tests for the run-scoped shared fact ledger.

The ledger exists to stop every isolated role from rediscovering what an
earlier role already confirmed. Its value depends entirely on being
trustworthy, so these tests pin the mechanical guarantees: only the CLI
writes it, a claim must carry a verifiable locator, and a correction is an
appended supersede rather than an edit.
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


class FactLedgerTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.ledger = self.root / "facts.jsonl"
        self._cwd = os.getcwd()
        os.chdir(self.root)
        Path("src").mkdir()
        Path("src/router.ts").write_text("route()\n", encoding="utf-8")
        Path("src/config.ts").write_text("loadConfig()\n", encoding="utf-8")

    def tearDown(self):
        os.chdir(self._cwd)
        self._tmp.cleanup()

    def append(self, entries, role="planner", handoff_id="h-1"):
        return facts.append_facts(self.ledger, entries, role=role, handoff_id=handoff_id)

    # --- writing -------------------------------------------------------

    def test_append_assigns_sequential_ids_and_returns_them(self):
        written = self.append(
            [
                {"claim": "route registration entry", "path": "src/router.ts", "line": 42},
                {"claim": "config loader", "path": "src/config.ts", "symbol": "loadConfig"},
            ]
        )
        self.assertEqual(["f1", "f2"], [entry["id"] for entry in written])

    def test_ids_keep_increasing_across_separate_handoffs(self):
        self.append([{"claim": "first", "path": "src/router.ts"}], handoff_id="h-1")
        second = self.append(
            [{"claim": "second", "path": "src/config.ts"}], role="coder", handoff_id="h-2"
        )
        self.assertEqual(["f2"], [entry["id"] for entry in second])

    def test_every_record_carries_its_author_and_handoff(self):
        self.append([{"claim": "route entry", "path": "src/router.ts"}], role="coder", handoff_id="h-9")
        record = json.loads(self.ledger.read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual("coder", record["role"])
        self.assertEqual("h-9", record["handoff_id"])
        self.assertEqual("fact", record["kind"])

    def test_ledger_is_append_only(self):
        self.append([{"claim": "first", "path": "src/router.ts"}])
        self.append([{"claim": "second", "path": "src/config.ts"}], role="coder", handoff_id="h-2")
        self.assertEqual(2, len(self.ledger.read_text(encoding="utf-8").strip().splitlines()))

    def test_empty_batch_writes_nothing(self):
        self.assertEqual([], self.append([]))
        self.assertFalse(self.ledger.exists())

    # --- claim validation ----------------------------------------------

    def test_claim_is_required(self):
        with self.assertRaises(facts.FactError):
            self.append([{"path": "src/router.ts"}])

    def test_blank_claim_is_rejected(self):
        with self.assertRaises(facts.FactError):
            self.append([{"claim": "   ", "path": "src/router.ts"}])

    def test_a_locator_is_required(self):
        """A claim with nowhere to check it is an opinion, not a fact."""
        with self.assertRaises(facts.FactError):
            self.append([{"claim": "the code is clean"}])

    def test_value_alone_is_a_valid_locator(self):
        written = self.append([{"claim": "test framework", "value": "vitest"}])
        self.assertEqual(["f1"], [entry["id"] for entry in written])

    def test_symbol_alone_is_a_valid_locator(self):
        written = self.append([{"claim": "entry symbol", "symbol": "main"}])
        self.assertEqual(["f1"], [entry["id"] for entry in written])

    def test_unknown_fields_are_rejected(self):
        with self.assertRaises(facts.FactError):
            self.append([{"claim": "x", "value": "y", "confidence": "high"}])

    def test_entry_must_be_an_object(self):
        with self.assertRaises(facts.FactError):
            self.append(["route registration is in src/router.ts"])

    # --- path verification ---------------------------------------------

    def test_nonexistent_path_is_rejected(self):
        """The CLI can check this mechanically, so it must."""
        with self.assertRaises(facts.FactError):
            self.append([{"claim": "router", "path": "src/nope.ts"}])

    def test_absolute_path_is_rejected(self):
        with self.assertRaises(facts.FactError):
            self.append([{"claim": "router", "path": str(self.root / "src" / "router.ts")}])

    def test_path_escaping_the_repository_is_rejected(self):
        with self.assertRaises(facts.FactError):
            self.append([{"claim": "outside", "path": "../elsewhere.ts"}])

    def test_line_must_be_a_positive_integer(self):
        with self.assertRaises(facts.FactError):
            self.append([{"claim": "router", "path": "src/router.ts", "line": 0}])

    # --- supersede ------------------------------------------------------

    def test_supersede_requires_a_known_target(self):
        with self.assertRaises(facts.FactError):
            self.append([{"supersedes": "f7", "claim": "moved", "path": "src/config.ts"}])

    def test_supersede_hides_the_original_from_the_view(self):
        self.append([{"claim": "route entry", "path": "src/router.ts", "line": 42}])
        self.append(
            [{"supersedes": "f1", "claim": "route entry", "path": "src/config.ts", "reason": "split"}],
            role="coder",
            handoff_id="h-2",
        )
        view = facts.materialize(self.ledger)
        self.assertEqual(1, len(view))
        self.assertEqual("f2", view[0]["id"])
        self.assertEqual("src/config.ts", view[0]["path"])

    def test_supersede_is_recorded_as_its_own_kind(self):
        self.append([{"claim": "route entry", "path": "src/router.ts"}])
        self.append(
            [{"supersedes": "f1", "claim": "moved", "path": "src/config.ts"}],
            role="coder",
            handoff_id="h-2",
        )
        kinds = [
            json.loads(line)["kind"]
            for line in self.ledger.read_text(encoding="utf-8").strip().splitlines()
        ]
        self.assertEqual(["fact", "supersede"], kinds)

    def test_superseding_twice_keeps_only_the_newest(self):
        self.append([{"claim": "v1", "path": "src/router.ts"}])
        self.append([{"supersedes": "f1", "claim": "v2", "path": "src/config.ts"}], handoff_id="h-2")
        self.append([{"supersedes": "f2", "claim": "v3", "path": "src/router.ts"}], handoff_id="h-3")
        view = facts.materialize(self.ledger)
        self.assertEqual(["f3"], [entry["id"] for entry in view])

    def test_a_correction_never_rewrites_history(self):
        self.append([{"claim": "v1", "path": "src/router.ts"}])
        before = self.ledger.read_text(encoding="utf-8")
        self.append([{"supersedes": "f1", "claim": "v2", "path": "src/config.ts"}], handoff_id="h-2")
        self.assertTrue(self.ledger.read_text(encoding="utf-8").startswith(before))

    # --- noise control --------------------------------------------------

    def test_a_handoff_cannot_dump_unlimited_facts(self):
        entries = [
            {"claim": f"claim {index}", "value": str(index)}
            for index in range(facts.MAX_FACTS_PER_HANDOFF + 1)
        ]
        with self.assertRaises(facts.FactError):
            self.append(entries)

    def test_claim_length_is_capped(self):
        with self.assertRaises(facts.FactError):
            self.append([{"claim": "x" * (facts.MAX_CLAIM_CHARS + 1), "value": "y"}])

    def test_a_rejected_batch_writes_nothing(self):
        """Validation happens before any append, so a bad entry cannot
        leave half a batch behind."""
        with self.assertRaises(facts.FactError):
            self.append(
                [
                    {"claim": "good", "path": "src/router.ts"},
                    {"claim": "bad", "path": "src/nope.ts"},
                ]
            )
        self.assertFalse(self.ledger.exists())

    # --- reading --------------------------------------------------------

    def test_materializing_a_missing_ledger_is_empty_not_an_error(self):
        self.assertEqual([], facts.materialize(self.root / "absent.jsonl"))

    def test_materialize_preserves_insertion_order(self):
        self.append([{"claim": "a", "value": "1"}, {"claim": "b", "value": "2"}])
        self.assertEqual(["a", "b"], [entry["claim"] for entry in facts.materialize(self.ledger)])

    def test_corrupt_lines_are_skipped_rather_than_crashing(self):
        """A damaged ledger must degrade to fewer facts, never break the run."""
        self.append([{"claim": "good", "value": "1"}])
        with open(self.ledger, "a", encoding="utf-8") as handle:
            handle.write("{not json\n")
        self.assertEqual(["good"], [entry["claim"] for entry in facts.materialize(self.ledger)])

    def test_render_is_empty_when_there_are_no_facts(self):
        self.assertEqual("", facts.render(self.root / "absent.jsonl"))

    def test_render_lists_id_claim_and_locator(self):
        self.append([{"claim": "route entry", "path": "src/router.ts", "line": 42}])
        rendered = facts.render(self.ledger)
        self.assertIn("f1", rendered)
        self.assertIn("route entry", rendered)
        self.assertIn("src/router.ts:42", rendered)

    def test_render_names_the_author_so_a_reader_can_judge_it(self):
        self.append([{"claim": "route entry", "value": "x"}], role="test-writer")
        self.assertIn("test-writer", facts.render(self.ledger))


if __name__ == "__main__":
    unittest.main()
