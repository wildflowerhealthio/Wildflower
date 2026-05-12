if [ -n "$GIT_NAME" ]; then
  git config --global user.name "$GIT_NAME"
fi
if [ -n "$GIT_EMAIL" ]; then
  git config --global user.email "$GIT_EMAIL"
fi
gh auth setup-git
sudo chown -R $(whoami) /workspaces/wildflower/node_modules

source /home/node/.bashrc
# curl -fsSL https://claude.ai/install.sh | bash
pnpm install -g vite-plus
pnpm install -g @typescript/native-preview
pnpm install -g @tsdown/css
vp install


echo 'alias danger-claude="claude --dangerously-skip-permissions"' >> ~/.bashrc