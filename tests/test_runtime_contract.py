"""Contract tests for the runtime's structural invariants.

These pin decisions that are cheap to violate by accident and expensive to
discover at model-call time: frontmatter shape, model bindings, the
delegation gate, and the boundary between the runtime and the memory system
that codeflow deliberately does not have.
"""

import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtime"
AGENTS = RUNTIME / "agents"
PI_RUNTIME = RUNTIME / "bin" / "pi-runtime"

ALLOWED_KEYS = {"description", "model", "tools", "delegates", "needs_project_rules"}


def frontmatter(path):
    """Parse top-level `key: value` pairs, matching pi-runtime's own parser."""
    fields = {}
    opened = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() == "---":
            if opened:
                break
            opened = True
            continue
        if not opened:
            continue
        if ":" in line and not line.startswith((" ", "\t")):
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip()
    return fields


def agent_files():
    return sorted(AGENTS.glob("*.md"))


class AgentFrontmatterTest(unittest.TestCase):
    def test_agents_exist(self):
        self.assertTrue(agent_files(), "no agent definitions found")

    def test_description_is_present_and_non_empty(self):
        for path in agent_files():
            with self.subTest(agent=path.stem):
                self.assertTrue(frontmatter(path).get("description"))

    def test_model_is_provider_qualified(self):
        for path in agent_files():
            with self.subTest(agent=path.stem):
                self.assertIn("/", frontmatter(path).get("model", ""))

    def test_no_unknown_frontmatter_keys(self):
        """Every extra knob is behavior not explained by the prompt."""
        for path in agent_files():
            with self.subTest(agent=path.stem):
                self.assertEqual(set(), set(frontmatter(path)) - ALLOWED_KEYS)

    def test_body_is_a_usable_system_prompt(self):
        for path in agent_files():
            with self.subTest(agent=path.stem):
                body = path.read_text(encoding="utf-8").split("---", 2)[-1].strip()
                self.assertGreater(len(body), 50)

    def test_only_planner_may_delegate(self):
        """One coordinator, one layer of workers: accountability stays legible."""
        delegators = [
            path.stem for path in agent_files() if frontmatter(path).get("delegates") == "true"
        ]
        self.assertEqual(["planner"], delegators)

    def test_needs_project_rules_uses_known_values(self):
        for path in agent_files():
            value = frontmatter(path).get("needs_project_rules")
            if value is not None:
                with self.subTest(agent=path.stem):
                    self.assertIn(value, ("false", "shared"))

    def test_executor_roles_do_not_receive_project_rules(self):
        """A role that only runs commands should not be steered by policy."""
        for role in ("test-runner", "command", "supervisor", "title-compressor"):
            with self.subTest(agent=role):
                self.assertEqual("false", frontmatter(AGENTS / f"{role}.md").get("needs_project_rules"))


class ModelBindingTest(unittest.TestCase):
    def setUp(self):
        self.providers = json.loads((RUNTIME / "models.json").read_text())["providers"]

    def test_every_role_provider_is_configured(self):
        for path in agent_files():
            provider = frontmatter(path)["model"].split("/", 1)[0]
            with self.subTest(agent=path.stem):
                self.assertIn(provider, self.providers)

    def test_every_role_model_is_offered_by_its_provider(self):
        for path in agent_files():
            provider, model = frontmatter(path)["model"].split("/", 1)
            with self.subTest(agent=path.stem):
                offered = [entry["id"] for entry in self.providers[provider]["models"]]
                self.assertIn(model, offered)

    def test_api_keys_come_from_the_environment(self):
        """No literal credential may sit in the repository."""
        for name, provider in self.providers.items():
            with self.subTest(provider=name):
                self.assertTrue(provider["apiKey"].startswith("$"))

    def test_roles_span_multiple_providers(self):
        """Per-role model binding is the reason the inner loop exists."""
        used = {frontmatter(path)["model"].split("/", 1)[0] for path in agent_files()}
        self.assertGreater(len(used), 1)


class RoleResolutionTest(unittest.TestCase):
    def resolve(self, role):
        result = subprocess.run(
            [sys.executable, str(PI_RUNTIME), "run", "--agent", role, "--print", "probe"],
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        return json.loads(result.stdout)

    def test_every_role_resolves(self):
        for path in agent_files():
            with self.subTest(agent=path.stem):
                self.assertEqual(path.stem, self.resolve(path.stem)["role"])

    def test_an_unknown_role_fails_loudly(self):
        result = subprocess.run(
            [sys.executable, str(PI_RUNTIME), "run", "--agent", "nonexistent", "--print", "x"],
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        self.assertEqual(1, result.returncode)

    def test_all_three_extensions_are_loaded(self):
        argv = self.resolve("planner")["argv"]
        loaded = {Path(argv[index + 1]).parent.name for index, token in enumerate(argv) if token == "--extension"}
        self.assertEqual({"codeflow-task", "codeflow-context", "agent-watchdog"}, loaded)

    def test_context_files_are_never_auto_loaded(self):
        """The context extension owns injection; implicit loading would make
        what a role knows unauditable."""
        self.assertIn("--no-context-files", self.resolve("planner")["argv"])

    def test_the_agent_file_is_the_system_prompt(self):
        argv = self.resolve("coder")["argv"]
        self.assertEqual(str(AGENTS / "coder.md"), argv[argv.index("--system-prompt") + 1])

    def test_tool_allowlists_are_passed_through(self):
        argv = self.resolve("test-runner")["argv"]
        self.assertIn("--tools", argv)
        self.assertEqual("read,bash,skill", argv[argv.index("--tools") + 1])

    def test_roles_without_an_allowlist_get_no_tools_flag(self):
        self.assertNotIn("--tools", self.resolve("planner")["argv"])

    def test_printing_a_binding_creates_no_run_artifacts(self):
        """A diagnostic that litters teaches people to ignore artifacts."""
        runs = ROOT / ".codeflow"
        self.assertFalse(runs.exists(), "test started with stale artifacts")
        self.resolve("planner")
        self.assertFalse(runs.exists(), "--print left artifacts behind")


class NoMemorySystemTest(unittest.TestCase):
    """Codeflow keeps run-scoped shared facts and nothing else. A stray
    reference to the durable memory system means a prompt is instructing a
    role to call something that does not exist."""

    def test_no_role_references_a_memory_command(self):
        for path in agent_files():
            with self.subTest(agent=path.stem):
                text = path.read_text(encoding="utf-8")
                self.assertNotIn("memory recall", text)
                self.assertNotIn("memory-capture", text)
                self.assertNotIn("basic-memory", text)

    def test_no_runtime_file_references_basic_memory(self):
        for path in RUNTIME.rglob("*"):
            if not path.is_file() or path.suffix not in (".py", ".ts", ".md", ".json"):
                continue
            with self.subTest(path=str(path.relative_to(RUNTIME))):
                self.assertNotIn("basic-memory", path.read_text(encoding="utf-8", errors="replace"))

    def test_blocked_reasons_do_not_mention_recall(self):
        source = (RUNTIME / "skills" / "write-handoff" / "scripts" / "handoff_state.py").read_text()
        self.assertNotIn("RECALL_BUDGET_EXCEEDED", source)

    def test_nothing_still_says_teamflow(self):
        """A stale name here means a command a user cannot run."""
        for path in RUNTIME.rglob("*"):
            if not path.is_file() or path.suffix not in (".py", ".ts", ".md", ".json", ""):
                continue
            with self.subTest(path=str(path.relative_to(RUNTIME))):
                content = path.read_text(encoding="utf-8", errors="replace")
                self.assertFalse(re.search("teamflow", content, re.IGNORECASE))


class SkillDocumentTest(unittest.TestCase):
    def setUp(self):
        self.text = (ROOT / "SKILL.md").read_text(encoding="utf-8")

    def test_frontmatter_declares_name_and_description(self):
        fields = frontmatter(ROOT / "SKILL.md")
        self.assertEqual("codeflow", fields["name"])
        self.assertTrue(fields["description"])

    def test_description_states_when_to_use_the_skill(self):
        self.assertIn("Use when", frontmatter(ROOT / "SKILL.md")["description"])

    def test_it_teaches_blocking_waits_rather_than_polling(self):
        self.assertIn("codeflow wait", self.text)
        self.assertIn("Never poll", self.text)

    def test_it_names_both_stop_signals(self):
        self.assertIn("BLOCKED", self.text)
        self.assertIn("runner_exited", self.text)

    def test_it_denies_that_silence_means_failure(self):
        """The most common outer-loop error is killing a working run."""
        self.assertIn("never failure evidence", self.text)

    def test_referenced_documents_exist(self):
        for name in re.findall(r"references/([a-z-]+\.md)", self.text):
            with self.subTest(reference=name):
                self.assertTrue((ROOT / "references" / name).is_file())


if __name__ == "__main__":
    unittest.main()
