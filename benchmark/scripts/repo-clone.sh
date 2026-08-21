#!/usr/bin/env bash
#
# Production default for CODEFLOW_BENCHMARK_REPO_CLONE_BIN (the seam contract
# in tests/benchmark/fakes/README.md §3).
#
#   <this> <repo> <base_commit> <workspaceDir>
#
# Provisions workspaceDir as a fresh git working tree whose HEAD is exactly
# base_commit, cloned from the dataset `repo` (GitHub `owner/name`). This is
# the live boundary: it needs network and writes ONLY inside workspaceDir —
# never the dataset cache, a source clone, or Codeflow's own checkouts.
#
# Exit 0 with HEAD == base_commit, non-zero on any failure (the runner records
# the attempt as infra_error).

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <repo> <base_commit> <workspaceDir>" >&2
  exit 2
fi

repo="$1"
base_commit="$2"
dest="$3"

case "$repo" in
  */*) url="https://github.com/${repo}.git" ;;
  *)   echo "repo-clone: expected owner/name, got: $repo" >&2; exit 2 ;;
esac

command -v git >/dev/null 2>&1 || { echo "repo-clone: git is not installed" >&2; exit 127; }

mkdir -p "$(dirname "$dest")"

# Full clone then checkout: SWE-bench base commits may be decades behind the
# default branch, and a filtered clone cannot always materialize arbitrary
# historical blobs. If the commit is absent (history rewrite or partial
# mirror), fetch it explicitly and retry once.
if ! git clone --quiet "$url" "$dest" 2>/dev/null; then
  echo "repo-clone: git clone failed for $url" >&2
  exit 1
fi
if ! git -C "$dest" checkout --quiet "$base_commit" 2>/dev/null; then
  git -C "$dest" fetch --quiet origin "$base_commit" || {
    echo "repo-clone: base_commit $base_commit not found in $repo" >&2
    exit 1
  }
  git -C "$dest" checkout --quiet "$base_commit"
fi

head="$(git -C "$dest" rev-parse HEAD)"
if [ "$head" != "$base_commit" ]; then
  echo "repo-clone: HEAD $head != base_commit $base_commit" >&2
  exit 1
fi
