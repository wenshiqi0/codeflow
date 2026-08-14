#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath


DIFF_RE = re.compile(r"^diff --git a/(.+) b/(.+)$")
HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
CFG_TEST_RE = re.compile(r"#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]")
MOD_RE = re.compile(r"\bmod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{")


def fail(message: str) -> None:
    print(json.dumps({"status": "FAIL", "error": message}, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(1)


def is_test_file(path: str) -> bool:
    parts = PurePosixPath(path).parts
    name = parts[-1] if parts else ""
    return (
        "tests" in parts
        or "test" in parts
        or "__tests__" in parts
        or name.startswith("test_")
        or name.endswith(("_test.rs", ".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"))
    )


def brace_delta(line: str) -> int:
    line = re.sub(r'"(?:\\.|[^"\\])*"', '""', line)
    line = line.split("//", 1)[0]
    return line.count("{") - line.count("}")


def rust_test_ranges(path: Path) -> list[tuple[int, int]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    ranges: list[tuple[int, int]] = []
    index = 0
    while index < len(lines):
        if not CFG_TEST_RE.search(lines[index]):
            index += 1
            continue
        attr_line = index + 1
        probe = index
        while probe < min(len(lines), index + 8) and not MOD_RE.search(lines[probe]):
            probe += 1
        if probe >= len(lines) or not MOD_RE.search(lines[probe]):
            index += 1
            continue
        depth = 0
        opened = False
        end = probe + 1
        while end <= len(lines):
            depth += brace_delta(lines[end - 1])
            opened = opened or "{" in lines[end - 1]
            if opened and depth == 0:
                break
            end += 1
        if opened and depth == 0:
            ranges.append((attr_line, end))
            index = end
        else:
            index += 1
    return ranges


def in_ranges(line: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start <= line <= end for start, end in ranges)


def validate_rust_format(project: Path, patch_path: Path, files: list[str]) -> None:
    rust_files = [path for path in files if path.endswith(".rs")]
    rustfmt = shutil.which("rustfmt")
    if not rust_files or rustfmt is None:
        return
    with tempfile.TemporaryDirectory(prefix="codeflow-test-patch-") as temporary:
        worktree = Path(temporary) / "repo"
        added = subprocess.run(
            ["git", "worktree", "add", "--detach", "--quiet", str(worktree), "HEAD"],
            cwd=project, text=True, capture_output=True,
        )
        if added.returncode != 0:
            fail(f"could not create formatting worktree: {added.stderr.strip()}")
        try:
            applied = subprocess.run(
                ["git", "apply", "--recount", str(patch_path)],
                cwd=worktree, text=True, capture_output=True,
            )
            if applied.returncode != 0:
                fail(f"patch did not apply in formatting worktree: {applied.stderr.strip()}")
            formatted = subprocess.run(
                [rustfmt, "--edition", "2021", "--check", *rust_files],
                cwd=worktree, text=True, capture_output=True,
            )
            if formatted.returncode != 0:
                detail = (formatted.stdout + formatted.stderr).strip()
                fail(f"Rust test patch is not rustfmt-clean: {detail}")
        finally:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree)],
                cwd=project, text=True, capture_output=True,
            )


def validate_patch(project: Path, patch_path: Path) -> dict:
    run_root = (project / ".codeflow" / "runs" / "test-patches").resolve()
    resolved_patch = patch_path.resolve()
    if not resolved_patch.is_file() or run_root not in resolved_patch.parents:
        fail("patch must be a file below .codeflow/runs/test-patches/")
    text = resolved_patch.read_text(encoding="utf-8")
    if "GIT binary patch" in text or "rename from " in text or "deleted file mode " in text:
        fail("binary, rename, and file deletion patches are not allowed")
    check = subprocess.run(
        ["git", "apply", "--check", "--recount", str(resolved_patch)],
        cwd=project,
        text=True,
        capture_output=True,
    )
    if check.returncode != 0:
        fail(f"git apply --check failed: {check.stderr.strip()}")

    lines = text.splitlines()
    files: list[str] = []
    current: str | None = None
    ranges: list[tuple[int, int]] = []
    old_line = new_line = 0
    hunk = False
    for line in lines:
        match = DIFF_RE.match(line)
        if match:
            left, right = match.groups()
            if left != right:
                fail("patch must not rename files")
            path = PurePosixPath(right)
            if path.is_absolute() or ".." in path.parts or not path.parts:
                fail(f"unsafe patch path: {right}")
            current = right
            files.append(right)
            hunk = False
            file_path = project / right
            ranges = rust_test_ranges(file_path) if file_path.is_file() and right.endswith(".rs") else []
            continue
        hunk_match = HUNK_RE.match(line)
        if hunk_match:
            if current is None:
                fail("hunk appeared before a file header")
            old_line = int(hunk_match.group(1))
            new_line = int(hunk_match.group(3))
            hunk = True
            continue
        if not hunk or current is None or line.startswith(("--- ", "+++ ")):
            continue
        full_test_file = is_test_file(current)
        if line.startswith(" "):
            old_line += 1
            new_line += 1
        elif line.startswith("-"):
            if not full_test_file and not (current.endswith(".rs") and in_ranges(old_line, ranges)):
                fail(f"non-test deletion rejected: {current}:{old_line}")
            old_line += 1
        elif line.startswith("+"):
            anchor = old_line
            if not full_test_file and not (
                current.endswith(".rs") and (in_ranges(anchor, ranges) or in_ranges(max(1, anchor - 1), ranges))
            ):
                fail(f"non-test addition rejected: {current}:{new_line}")
            new_line += 1
        elif line.startswith("\\ No newline"):
            continue

    if not files:
        fail("patch contains no files")
    validate_rust_format(project, resolved_patch, sorted(set(files)))
    return {
        "status": "PASS",
        "patch": str(resolved_patch.relative_to(project)),
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "files": sorted(set(files)),
    }


def file_fingerprints(project: Path, files: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for relative in files:
        path = project / relative
        if is_test_file(relative):
            payload = path.read_text(encoding="utf-8")
        elif relative.endswith(".rs"):
            lines = path.read_text(encoding="utf-8").splitlines()
            ranges = rust_test_ranges(path)
            if not ranges:
                fail(f"applied Rust file has no test region: {relative}")
            payload = "\n".join("\n".join(lines[start - 1:end]) for start, end in ranges)
        else:
            fail(f"cannot fingerprint non-test file: {relative}")
        result[relative] = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate and apply test-only patches")
    parser.add_argument("action", choices=("check", "apply", "verify"))
    parser.add_argument("patch")
    args = parser.parse_args()
    project = Path.cwd().resolve()
    patch_path = Path(args.patch).resolve()
    lock_path = patch_path.with_suffix(patch_path.suffix + ".lock.json")
    if args.action == "verify":
        if not lock_path.is_file():
            fail(f"test lock does not exist: {lock_path}")
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        patch_sha = hashlib.sha256(patch_path.read_bytes()).hexdigest()
        if lock.get("patch_sha256") != patch_sha:
            fail("test patch checksum no longer matches its lock")
        current = file_fingerprints(project, list(lock.get("files", {}).keys()))
        changed = sorted(path for path, digest in current.items() if lock["files"].get(path) != digest)
        if changed:
            fail(f"applied requirement tests changed after lock: {changed}")
        print(json.dumps({"status": "PASS", "patch": args.patch, "patch_sha256": patch_sha, "tests_unchanged": True}, indent=2))
        return
    result = validate_patch(project, Path(args.patch))
    if args.action == "apply":
        applied = subprocess.run(
            ["git", "apply", "--recount", "--whitespace=error", str((project / args.patch).resolve())],
            cwd=project,
            text=True,
            capture_output=True,
        )
        if applied.returncode != 0:
            fail(f"git apply failed after validation: {applied.stderr.strip()}")
        result["applied"] = True
        lock = {"schema_version": 1, "patch_sha256": result["sha256"], "files": file_fingerprints(project, result["files"])}
        lock_path.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
        result["lock"] = str(lock_path.relative_to(project))
    else:
        result["applied"] = False
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
