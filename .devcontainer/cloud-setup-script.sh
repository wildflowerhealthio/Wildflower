#!/bin/bash
# Wildflower — Claude Code cloud-environment Setup script (REFERENCE COPY).
#
# This is NOT executed from the repo. Paste its body into the "Setup script"
# field of your cloud environment (claude.ai/code → environment settings; or
# admin settings for a shared env). It is versioned here so the canonical text
# lives with the code and stays reviewable; update both together.
#
# It runs once, before Claude Code launches; the filesystem is then snapshotted
# and reused for ~7 days, so this toolchain provisioning is cached, not repeated
# per session. It re-runs only when you edit this script or the env's allowed
# hosts, or when the cache expires.
#
# Mirrors .claude/hooks/session-start.sh (the per-session bootstrap). The one
# thing this script must NOT assume is that its CWD is the repo root: the
# provisioning shell has been observed to start in $HOME, which has no
# package.json — a bare `vp install` there failed as `npm ENOENT` on
# /home/user/package.json. So locate the checkout before installing.
set -euo pipefail

export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
export PATH="$PNPM_HOME:$PATH"

# 1. Node 26+ (package.json `engines`; the base image ships an older Node).
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 26 ? 0 : 1)' 2>/dev/null; then
  pnpm env use --global 26
fi

# 2. Global `vp` + the helpers the devcontainer installs alongside it. Pin
#    every one to the version the workspace resolves so the bootstrap toolchain
#    can't drift ahead of it — unpinned, `vite-plus` drifts to the newest
#    release (a box once pulled 0.3.1 while the workspace held 0.3.0) and
#    peer-warns. Re-sync on every bump; the full list of places a vite-plus
#    version is recorded is in docs/Dependencies/Bumping vite-plus How-To.md.
if ! command -v vp >/dev/null 2>&1; then
  pnpm install -g vite-plus@0.3.0 @typescript/native-preview@7.0.0-dev.20260707.2 '@tsdown/css@^0.23.0'
fi

# 3. Warm the workspace install so node_modules + the pnpm store land in the
#    snapshot. The repo's SessionStart hook still runs `vp install` per session
#    to reconcile the cloned branch's actual lockfile (fast when cache is
#    current). Locate the checkout first — the setup CWD is not reliably the
#    repo root, and the repo may not even be cloned yet at provision time.
workspace=""
for candidate in "${CLAUDE_PROJECT_DIR:-}" "$PWD" "$HOME"/*; do
  if [ -n "$candidate" ] && [ -f "$candidate/pnpm-workspace.yaml" ]; then
    workspace="$candidate"
    break
  fi
done

if [ -n "$workspace" ]; then
  cd "$workspace"
  vp install
  echo "setup-script: node $(node --version), vp $(vp --version), workspace warmed at $workspace"
else
  echo "setup-script: no pnpm-workspace.yaml found at provision time — skipping the warm install; the SessionStart hook runs 'vp install' after the branch is cloned" >&2
fi
