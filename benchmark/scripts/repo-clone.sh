#!/usr/bin/env bash
#
# Production default for CODEFLOW_BENCHMARK_REPO_CLONE_BIN (the seam contract
# in tests/benchmark/fakes/README.md §3).
#
#   <this> <repo> <base_commit> <workspaceDir>
#
# Provisions workspaceDir as a fresh git working tree whose source tree is
# exactly base_commit from the dataset `repo` (GitHub `owner/name`). A source
# clone containing that commit and tree at
# $CODEFLOW_BENCHMARK_REPO_CACHE_DIR/<name>, or by default
# $HOME/Documents/swe/<name>, is used read-only when present; otherwise this
# live boundary clones GitHub. It writes ONLY inside workspaceDir — never the
# dataset cache, source clone, or Codeflow's own checkouts.
#
# Exit 0 after materializing base_commit as a one-commit benchmark workspace;
# exit non-zero on failure (the runner records the attempt as infra_error).

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

cache_root="${CODEFLOW_BENCHMARK_REPO_CACHE_DIR:-${HOME:-}/Documents/swe}"
cache_repo="${cache_root%/}/${repo##*/}"
clone_source="$url"
clone_mode="remote"
if [ -n "$cache_root" ] && git -C "$cache_repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  clone_source="$cache_repo"
  clone_mode="local cache"
fi

# Full clone then checkout: SWE-bench base commits may be decades behind the
# default branch, and a filtered clone cannot always materialize arbitrary
# historical blobs. If the commit is absent (history rewrite or partial
# mirror), fetch it explicitly and retry once.
#
# An executor must not see the repository's later history: it can otherwise find
# an upstream fix by searching commits after the benchmark base. Once the
# exact base tree is materialized, replace its object database with a synthetic
# one-commit repository. This preserves ordinary `git diff` patch extraction
# while removing all remote refs and future commit objects.
if [ "$clone_mode" = "local cache" ]; then
  clone_args=(--quiet --local "$clone_source" "$dest")
else
  clone_args=(--quiet "$clone_source" "$dest")
fi
if ! git clone "${clone_args[@]}" 2>/dev/null; then
  echo "repo-clone: git clone failed from $clone_mode: $clone_source" >&2
  exit 1
fi
if ! git -C "$dest" checkout --quiet "$base_commit" 2>/dev/null; then
  git -C "$dest" fetch --quiet origin "$base_commit" || {
    echo "repo-clone: base_commit $base_commit not found in $repo via $clone_mode" >&2
    exit 1
  }
  git -C "$dest" checkout --quiet "$base_commit"
fi

head="$(git -C "$dest" rev-parse HEAD)"
if [ "$head" != "$base_commit" ]; then
  echo "repo-clone: HEAD $head != base_commit $base_commit" >&2
  exit 1
fi

rm -rf "$dest/.git"
git -C "$dest" init --quiet --initial-branch=benchmark-base
git -C "$dest" add --all
git -C "$dest" -c user.name=codeflow-benchmark -c user.email=benchmark@codeflow.invalid \
  commit --quiet --allow-empty -m "benchmark base workspace"
