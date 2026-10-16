#!/usr/bin/env bash
# Writes pr-preview.yml's comment on a pull request: the one comment that
# starts with the preview marker is edited in place, so a PR carries a single
# preview comment however many times it deploys.
#
#   upsert-preview-comment.sh <body-file> [--update-only]
#
# `--update-only` edits the comment if there is one and otherwise posts
# nothing: a PR that never had a preview gets no comment saying so.
#
# Needs `GH_TOKEN`, `GITHUB_REPOSITORY` and `PR_NUMBER`.
set -euo pipefail

marker='<!-- pages-preview -->'

body_file=${1:?usage: upsert-preview-comment.sh <body-file> [--update-only]}
update_only=${2:-}
: "${GITHUB_REPOSITORY:?}" "${PR_NUMBER:?}"

body="$marker
$(cat "$body_file")"

existing=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments" \
  --jq ".[] | select(.body | startswith(\"$marker\")) | .id" | sed -n 1p)

if [[ -n $existing ]]; then
  gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$existing" \
    --raw-field body="$body" > /dev/null
  echo "Updated preview comment $existing"
elif [[ $update_only != --update-only ]]; then
  gh api --method POST "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments" \
    --raw-field body="$body" > /dev/null
  echo 'Posted the preview comment'
else
  echo 'No preview comment to update'
fi
