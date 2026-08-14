#!/usr/bin/env python3
import argparse
import subprocess
import sys
from pathlib import Path


TEXT_SUFFIXES = {
    ".c", ".cc", ".cpp", ".css", ".go", ".h", ".hpp", ".html", ".java",
    ".js", ".json", ".jsx", ".md", ".py", ".rs", ".sh", ".sql", ".toml",
    ".ts", ".tsx", ".txt", ".yaml", ".yml",
}
ALLOWED_CONTROLS = {0x09, 0x0A, 0x0D}


def changed_paths() -> list[Path]:
    result = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        check=True,
        capture_output=True,
    )
    items = result.stdout.split(b"\0")
    paths: list[Path] = []
    index = 0
    while index < len(items):
        item = items[index]
        index += 1
        if not item:
            continue
        status = item[:2]
        raw_path = item[3:]
        if status[:1] in {b"R", b"C"}:
            if index >= len(items):
                break
            raw_path = items[index]
            index += 1
        path = Path(raw_path.decode("utf-8", errors="surrogateescape"))
        if ".codeflow" not in path.parts:
            paths.append(path)
    return paths


def forbidden_bytes(data: bytes) -> list[tuple[int, int]]:
    return [
        (index, byte)
        for index, byte in enumerate(data)
        if (byte < 0x20 and byte not in ALLOWED_CONTROLS) or byte == 0x7F
    ]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Reject non-printing control bytes in changed text source files"
    )
    parser.add_argument("paths", nargs="*", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        assert not forbidden_bytes(b"plain\tline\ncarriage\rutf8:\xe4\xb8\xad")
        assert [byte for _, byte in forbidden_bytes(b"nul\x00esc\x1bdel\x7f")] == [0, 27, 127]
        print('{"status":"PASS","self_test":true}')
        return
    paths = args.paths or changed_paths()
    errors: list[str] = []
    checked = 0
    for path in sorted(set(paths)):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        data = path.read_bytes()
        checked += 1
        line = 1
        column = 0
        forbidden = dict(forbidden_bytes(data))
        for index, byte in enumerate(data):
            if byte == 0x0A:
                line += 1
                column = 0
                continue
            column += 1
            if index in forbidden:
                errors.append(f"{path}:{line}:{column}: forbidden control byte 0x{byte:02x}")
    if errors:
        print("source safety check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        raise SystemExit(1)
    print(f'{{"status":"PASS","checked_files":{checked}}}')


if __name__ == "__main__":
    main()
