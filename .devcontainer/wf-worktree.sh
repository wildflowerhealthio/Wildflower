#!/usr/bin/env bash
# wf-worktree.sh — manage parallel git worktrees for in-devcontainer agents.
#
# Layout: the worktree itself lives under `${main}/.worktrees/<branch>/` so it
# is visible to the host filesystem (via the existing bind mount), but its
# `node_modules` is a symlink to `/data/worktree-node_modules/<branch>/` on the
# Linux-native wf-data volume. That keeps installs fast (hardlinked from the
# shared pnpm store at /data/pnpm-store) and dependency files off the slow
# macOS↔Linux mount, while leaving source files editable from host VSCode.
#
# See CLAUDE.md "Parallel Worktrees" for the full rationale and tradeoffs.

set -euo pipefail

MAIN_REPO="${WF_MAIN_REPO:-/workspaces/wildflower}"
WORKTREES_ROOT="${WF_WORKTREES_ROOT:-$MAIN_REPO/.worktrees}"
NODE_MODULES_ROOT="${WF_NODE_MODULES_ROOT:-/data/worktree-node_modules}"

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [args]

Commands:
  new <branch> [<base>]   Create a worktree at \$WF_WORKTREES_ROOT/<branch> with
                          its node_modules symlinked to \$WF_NODE_MODULES_ROOT/<branch>,
                          then run \`vp install\`. <base> defaults to main. If
                          <branch> already exists locally it is checked out
                          instead of created.
  list                    Show all git worktrees attached to the main repo.
  remove <branch>         Remove the worktree, its node_modules dir on /data,
                          and prune git's record of it.

Env overrides:
  WF_MAIN_REPO            (default: /workspaces/wildflower)
  WF_WORKTREES_ROOT       (default: \$WF_MAIN_REPO/.worktrees)
  WF_NODE_MODULES_ROOT    (default: /data/worktree-node_modules)
EOF
}

require_data_volume() {
  local parent
  parent="$(dirname "$NODE_MODULES_ROOT")"
  if [ ! -d "$parent" ]; then
    echo "error: $parent does not exist." >&2
    echo "Run inside the devcontainer where the wf-data volume is mounted at /data," >&2
    echo "or set WF_NODE_MODULES_ROOT to a writable directory on a Linux-native filesystem." >&2
    exit 1
  fi
}

cmd_new() {
  local branch="${1:-}"
  local base="${2:-main}"
  if [ -z "$branch" ]; then
    echo "error: branch name required" >&2
    usage
    exit 1
  fi
  require_data_volume

  mkdir -p "$WORKTREES_ROOT" "$NODE_MODULES_ROOT"
  local worktree_dir="$WORKTREES_ROOT/$branch"
  local nm_dir="$NODE_MODULES_ROOT/$branch"

  if [ -e "$worktree_dir" ]; then
    echo "error: $worktree_dir already exists" >&2
    exit 1
  fi

  if git -C "$MAIN_REPO" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$MAIN_REPO" worktree add "$worktree_dir" "$branch"
  else
    git -C "$MAIN_REPO" worktree add -b "$branch" "$worktree_dir" "$base"
  fi

  mkdir -p "$nm_dir"
  ln -sfn "$nm_dir" "$worktree_dir/node_modules"

  (cd "$worktree_dir" && vp install)

  echo
  echo "Worktree ready: $worktree_dir"
  echo "  node_modules → $nm_dir"
  echo "  cd $worktree_dir"
}

cmd_list() {
  git -C "$MAIN_REPO" worktree list
}

cmd_remove() {
  local branch="${1:-}"
  if [ -z "$branch" ]; then
    echo "error: branch name required" >&2
    usage
    exit 1
  fi
  local worktree_dir="$WORKTREES_ROOT/$branch"
  local nm_dir="$NODE_MODULES_ROOT/$branch"
  git -C "$MAIN_REPO" worktree remove "$worktree_dir"
  rm -rf "$nm_dir"
}

case "${1:-}" in
  new) shift; cmd_new "$@" ;;
  list) shift; cmd_list "$@" ;;
  remove|rm) shift; cmd_remove "$@" ;;
  ""|-h|--help|help) usage ;;
  *) echo "unknown command: $1" >&2; usage; exit 1 ;;
esac
