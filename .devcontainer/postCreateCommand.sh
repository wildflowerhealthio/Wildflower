if [ -n "$GIT_NAME" ]; then
  git config --global user.name "$GIT_NAME"
fi
if [ -n "$GIT_EMAIL" ]; then
  git config --global user.email "$GIT_EMAIL"
fi
gh auth setup-git
sudo chown -R $(whoami) /workspaces/wildflower/node_modules
# curl -fsSL https://claude.ai/install.sh | bash
npm install -g vite-plus
npm install -g @typescript/native-preview
vp install

echo 'alias danger-claude="claude --dangerously-skip-permissions"' >> ~/.bashrc