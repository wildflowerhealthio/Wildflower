if [ -n "$GIT_NAME" ]; then
  git config --global user.name "$GIT_NAME"
fi
if [ -n "$GIT_EMAIL" ]; then
  git config --global user.email "$GIT_EMAIL"
fi
gh auth setup-git
sudo chown -R $(whoami) /workspaces/wildflower/node_modules

# /data layout (persistent across rebuilds) — see CLAUDE.md "Parallel Worktrees".
sudo mkdir -p /data/pnpm-store /data/pnpm-cache /data/pnpm-global /data/worktrees
sudo chown -R "$(whoami)" /data
pnpm config set store-dir /data/pnpm-store
pnpm config set cache-dir /data/pnpm-cache

# Set PNPM_HOME explicitly: `pnpm setup` does not reliably write to ~/.bashrc
# when the file already has a custom prompt block, which left vp unreachable.
export PNPM_HOME=/data/pnpm-global
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
if ! grep -q 'PNPM_HOME=/data/pnpm-global' ~/.bashrc; then
  cat >> ~/.bashrc <<'BASHRC_EOF'

export PNPM_HOME=/data/pnpm-global
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
BASHRC_EOF
fi

echo '\nalias danger-claude="claude --dangerously-skip-permissions"' >> ~/.bashrc
source /home/node/.bashrc

pnpm install -g vite-plus
pnpm install -g @typescript/native-preview
pnpm install -g @tsdown/css
vp install
