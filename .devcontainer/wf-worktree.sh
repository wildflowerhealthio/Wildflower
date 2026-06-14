#!/usr/bin/env bash
# wf-worktree.sh — manage parallel git worktrees for in-devcontainer agents.
#
# Layout: the worktree itself lives under `${main}/.worktrees/<branch>/` so it
# is visible to the host filesystem (via the existing bind mount), but its
# `node_modules` is a symlink to `/data/worktrees/<branch>/node_modules/` on
# the Linux-native wf-data volume. The `node_modules/` segment in the target
# path is required: Node canonicalizes through symlinks during require
# resolution, so the realpath chain must contain a literal `node_modules/`
# ancestor for scoped optional deps (e.g. `@voidzero-dev/vite-plus-<plat>`) to
# resolve. Installs hardlink from the shared pnpm store at /data/pnpm-store,
# keeping deps off the slow macOS↔Linux mount while source files remain
# editable from host VSCode.
#
# Cargo's target/ is also redirected per-worktree to
# /data/cargo-target/worktrees/<branch>/ via a generated .cargo/config.toml in
# the worktree, for the same bind-mount-avoidance reason. The main checkout's
# equivalent redirect is set up by postCreateCommand.sh.
#
# See CLAUDE.md "Parallel Worktrees" for the full rationale and tradeoffs.

set -euo pipefail

MAIN_REPO="${WF_MAIN_REPO:-/workspaces/wildflower}"
WORKTREES_ROOT="${WF_WORKTREES_ROOT:-$MAIN_REPO/.worktrees}"
WORKTREE_DATA_ROOT="${WF_WORKTREE_DATA_ROOT:-/data/worktrees}"
CARGO_TARGET_ROOT="${WF_CARGO_TARGET_ROOT:-/data/cargo-target/worktrees}"

# Fall back to the main repo's local vp if the global pnpm install hasn't been
# done (e.g. an existing container that predates the postCreate update).
if ! command -v vp >/dev/null 2>&1 && [ -x "$MAIN_REPO/node_modules/.bin/vp" ]; then
  export PATH="$MAIN_REPO/node_modules/.bin:$PATH"
fi

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [args]

Commands:
  new <branch> [<base>]   Create a worktree at \$WF_WORKTREES_ROOT/<branch> with
                          its node_modules symlinked to
                          \$WF_WORKTREE_DATA_ROOT/<branch>/node_modules and a
                          generated .cargo/config.toml pointing target-dir at
                          \$WF_CARGO_TARGET_ROOT/<branch>, then run
                          \`vp install\`. <base> defaults to main. If <branch>
                          already exists locally it is checked out instead of
                          created.
  list                    Show all git worktrees attached to the main repo.
  remove <branch>         Remove the worktree, its node_modules + cargo target
                          dirs on /data, empty parent directories for slashed
                          branch names, and prune git's record of it.

Env overrides:
  WF_MAIN_REPO            (default: /workspaces/wildflower)
  WF_WORKTREES_ROOT       (default: \$WF_MAIN_REPO/.worktrees)
  WF_WORKTREE_DATA_ROOT   (default: /data/worktrees)
  WF_CARGO_TARGET_ROOT    (default: /data/cargo-target/worktrees)
EOF
}

require_data_volume() {
  local parent
  parent="$(dirname "$WORKTREE_DATA_ROOT")"
  if [ ! -d "$parent" ]; then
    echo "error: $parent does not exist." >&2
    echo "Run inside the devcontainer where the wf-data volume is mounted at /data," >&2
    echo "or set WF_WORKTREE_DATA_ROOT to a writable directory on a Linux-native filesystem." >&2
    exit 1
  fi
}

# `git worktree add --relative-paths` landed in git 2.48 (Jan 2025). On
# older git the option is rejected with an opaque "unknown option"
# message that doesn't hint at the version requirement; detect early and
# print something actionable instead. $1 is the minimum required
# version, in `MAJOR.MINOR` form.
require_git() {
  local required="$1"
  local actual
  actual="$(git --version 2>/dev/null | awk '{print $3}')"
  if [ -z "$actual" ]; then
    echo "error: \`git\` not found on PATH." >&2
    exit 1
  fi
  # Sort the two versions; if the lower of the pair isn't $required, $actual is older.
  local lower
  lower="$(printf '%s\n%s\n' "$required" "$actual" | sort -V | head -n1)"
  if [ "$lower" != "$required" ]; then
    echo "error: git $required or newer required (found $actual)." >&2
    echo "\`git worktree add --relative-paths\` landed in git 2.48; older git fails with an opaque \"unknown option\"." >&2
    exit 1
  fi
}

# Reject any branch name git itself would reject — keeps `..` and other
# traversal segments from being interpolated into the filesystem paths and
# `rm -rf` targets that `cmd_new` / `cmd_remove` build below.
validate_branch() {
  local branch="$1"
  if ! git -C "$MAIN_REPO" check-ref-format --branch "$branch" >/dev/null 2>&1; then
    echo "error: '$branch' is not a valid git branch name" >&2
    exit 1
  fi
}

# Walk up from $1 (exclusive) toward $2 (exclusive), rmdir'ing empties. Used
# after `remove` so slashed branch names (`foo/bar`) don't leave empty `foo/`
# parents behind in either the worktrees root or the data root.
prune_empty_parents() {
  local start="$1" stop="$2"
  local p
  p="$(dirname "$start")"
  while [ "$p" != "$stop" ] && [ "$p" != "/" ]; do
    rmdir "$p" 2>/dev/null || break
    p="$(dirname "$p")"
  done
}

cmd_new() {
  local branch="${1:-}"
  local base="${2:-main}"
  if [ -z "$branch" ]; then
    echo "error: branch name required" >&2
    usage
    exit 1
  fi
  require_git 2.48
  validate_branch "$branch"
  require_data_volume

  local worktree_dir="$WORKTREES_ROOT/$branch"
  local nm_dir="$WORKTREE_DATA_ROOT/$branch/node_modules"
  local cargo_target_dir="$CARGO_TARGET_ROOT/$branch"

  if [ -e "$worktree_dir" ]; then
    echo "error: $worktree_dir already exists" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$worktree_dir")" "$nm_dir" "$cargo_target_dir"

  # --relative-paths writes both the admin gitdir pointer and the worktree's
  # .git file as paths relative to the workspace root. The container path
  # `/workspaces/wildflower/...` does not exist on the host, so absolute
  # pointers leave host-side git tooling (CLI, VSCode source control, GitLens)
  # unable to enumerate or open the worktrees. Relative paths resolve from
  # both views since the bind-mount preserves the layout. Requires git 2.48+.
  if git -C "$MAIN_REPO" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$MAIN_REPO" worktree add --relative-paths "$worktree_dir" "$branch"
  else
    git -C "$MAIN_REPO" worktree add --relative-paths -b "$branch" "$worktree_dir" "$base"
  fi

  ln -sfn "$nm_dir" "$worktree_dir/node_modules"

  # Per-worktree cargo target dir on /data — keeps incremental output off the
  # bind mount, same rationale as the node_modules redirect above. .cargo/ is
  # gitignored, so the generated config never gets committed.
  mkdir -p "$worktree_dir/.cargo"
  # Escape backslashes then double-quotes for TOML basic-string syntax.
  # `validate_branch` already rejects these in $branch, but $CARGO_TARGET_ROOT
  # is an env override and could contain either.
  local cargo_target_dir_toml="${cargo_target_dir//\\/\\\\}"
  cargo_target_dir_toml="${cargo_target_dir_toml//\"/\\\"}"
  cat > "$worktree_dir/.cargo/config.toml" <<CARGO_CONFIG_EOF
# Generated by .devcontainer/wf-worktree.sh — do not commit.
[build]
target-dir = "$cargo_target_dir_toml"
CARGO_CONFIG_EOF

  (cd "$worktree_dir" && vp install)

  echo
  echo "Worktree ready: $worktree_dir"
  echo "  node_modules     → $nm_dir"
  echo "  cargo target-dir → $cargo_target_dir"
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
  validate_branch "$branch"
  local worktree_dir="$WORKTREES_ROOT/$branch"
  local branch_data_dir="$WORKTREE_DATA_ROOT/$branch"
  local branch_cargo_target_dir="$CARGO_TARGET_ROOT/$branch"
  git -C "$MAIN_REPO" worktree remove "$worktree_dir"
  rm -rf "$branch_data_dir"
  rm -rf "$branch_cargo_target_dir"
  prune_empty_parents "$worktree_dir" "$WORKTREES_ROOT"
  prune_empty_parents "$branch_data_dir" "$WORKTREE_DATA_ROOT"
  prune_empty_parents "$branch_cargo_target_dir" "$CARGO_TARGET_ROOT"
}

case "${1:-}" in
  new) shift; cmd_new "$@" ;;
  list) shift; cmd_list "$@" ;;
  remove|rm) shift; cmd_remove "$@" ;;
  ""|-h|--help|help) usage ;;
  *) echo "unknown command: $1" >&2; usage; exit 1 ;;
esac
