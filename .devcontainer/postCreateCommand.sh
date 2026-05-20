if [ -n "$GIT_NAME" ]; then
  git config --global user.name "$GIT_NAME"
fi
if [ -n "$GIT_EMAIL" ]; then
  git config --global user.email "$GIT_EMAIL"
fi
gh auth setup-git
sudo chown -R $(whoami) /workspaces/wildflower/node_modules

# bootstrap-only — vp not yet installed, so pnpm is the only way to
# bring the toolchain in. Once `vp` exists, everything else routes
# through `vp` per project CLAUDE.md.
pnpm setup
source /home/node/.bashrc

# Point pnpm at the shared /data volume for store + cache, and reserve a
# Linux-native location for parallel-worktree node_modules. All three live on
# the wf-data volume so they survive container rebuilds and so each worktree's
# node_modules hardlinks from a single store. The worktrees themselves live in
# .worktrees/ inside the main bind mount (host-visible); only their
# node_modules is relocated here via symlink. See CLAUDE.md "Parallel
# Worktrees" for the full layout.
sudo mkdir -p /data/pnpm-store /data/pnpm-cache /data/worktree-node_modules
sudo chown -R "$(whoami)" /data
pnpm config set store-dir /data/pnpm-store
pnpm config set cache-dir /data/pnpm-cache

pnpm install -g vite-plus
pnpm install -g @typescript/native-preview
pnpm install -g @tsdown/css
vp install


echo 'alias danger-claude="claude --dangerously-skip-permissions"' >> ~/.bashrc