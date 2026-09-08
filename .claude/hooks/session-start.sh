#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Fresh web-session containers ship Node 22, no global `vp`, and no
# node_modules — so every documented command (`vp check`, `vp test`, …)
# fails until this bootstrap runs. Mirrors .devcontainer/postCreateCommand.sh
# minus the devcontainer-specific /data volume layout.
set -euo pipefail

# Local sessions (devcontainer/host) are provisioned already — do nothing.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# The SessionStart hook always exports CLAUDE_PROJECT_DIR; guard it anyway so a
# misconfigured invocation fails loud instead of `cd`-ing to $HOME under set -u
# and running the install against the wrong tree (the failure mode that bit the
# cloud Setup script — see .devcontainer/cloud-setup-script.sh).
cd "${CLAUDE_PROJECT_DIR:?CLAUDE_PROJECT_DIR is unset — cannot locate the workspace}"

export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac

# 1. Node 26+ (package.json engines; container default is older).
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 26 ? 0 : 1)' 2>/dev/null; then
  pnpm env use --global 26
fi

# 2. Global vp + the helpers postCreateCommand.sh installs alongside it.
#    Pin vite-plus to the workspace catalog's version (pnpm-workspace.yaml
#    `vite-plus:`) — an unpinned `vite-plus` drifts to the newest release
#    (a cloud box pulled 0.3.1 while the workspace holds 0.3.0), whose bundled
#    vitest peer-warns against the aliased vite. Keep this in sync on every
#    vite-plus bump, alongside the overrides in the root package.json.
if ! command -v vp >/dev/null 2>&1; then
  pnpm install -g vite-plus@0.3.0 @typescript/native-preview @tsdown/css
fi

# 3. Workspace dependencies (idempotent; fast when node_modules is current).
vp install

# 4. Persist PATH for the session: workspace-local .bin first so `vp` resolves
#    to the pinned vite-plus (the global vp's bundled vitest cannot resolve
#    jsdom for browser-env packages — see AGENTS.md "Fresh container bootstrap").
{
  echo "export PNPM_HOME=\"$PNPM_HOME\""
  echo "export PATH=\"$CLAUDE_PROJECT_DIR/node_modules/.bin:$PNPM_HOME:\$PATH\""
} >> "$CLAUDE_ENV_FILE"

echo "session-start: node $(node --version), vp $(vp --version), workspace installed"
