#!/usr/bin/env bash
# Publishes one site to a GitHub Pages branch, or removes a PR preview from it,
# for deploy-pages-site.yml and pr-preview.yml:
#
#   publish-pages-branch.sh production <build-dir> <custom-domain> <404-page>
#   publish-pages-branch.sh preview <pr-number> <build-dir> <404-page>
#   publish-pages-branch.sh teardown <pr-number>
#
# The branch (`PAGES_BRANCH`) of the repository at `PAGES_REMOTE` (a URL
# carrying its push token, or a local path) holds a site at its root and the
# PR previews in `pr-<n>/` directories beside it. Each mode rewrites only its
# own part:
#
# - production replaces everything but the `pr-<n>/` directories with the
#   build, plus the `CNAME` naming the custom domain, `.nojekyll` and the
#   `404.html`, which Pages reads only from the branch root.
# - preview replaces `pr-<n>/` with the build, minus any `CNAME`, and writes
#   `.nojekyll` and `404.html` at the root. On a branch with a production
#   site (a root `CNAME`) the preview writes `404.html` only if there is none
#   yet, leaving it to the production deploy to keep current; on a branch that
#   only holds previews, such as the marketing site's staging branch, every
#   preview refreshes it.
# - teardown removes `pr-<n>/`.
#
# The branch is a build output with no history worth keeping, so every publish
# replaces it with a single parentless commit. It is pushed with a lease on the
# tip it was built from: when another deploy (production, or another PR's
# preview) moved the branch in between, the push is refused and the whole
# rewrite is retried on the new tip, so no deploy overwrites another's part.
#
# Optional: `PAGES_COMMIT_MESSAGE`, the commit's message.
set -euo pipefail

usage() {
  sed -n '2,8p' "$0" >&2
  exit 2
}

fail() {
  echo "::error::$*" >&2
  exit 1
}

: "${PAGES_REMOTE:?PAGES_REMOTE must name the Pages repository}"
: "${PAGES_BRANCH:?PAGES_BRANCH must name the Pages branch}"
commit_message=${PAGES_COMMIT_MESSAGE:-Deploy}

mode=${1:-}
build_dir=
custom_domain=
not_found_page=
preview_dir=
case "$mode" in
  production)
    [[ $# -eq 4 ]] || usage
    build_dir=$2 custom_domain=$3 not_found_page=$4
    ;;
  preview)
    [[ $# -eq 4 ]] || usage
    preview_dir="pr-$2" build_dir=$3 not_found_page=$4
    ;;
  teardown)
    [[ $# -eq 2 ]] || usage
    preview_dir="pr-$2"
    ;;
  *) usage ;;
esac

# A `pr-<n>/` directory is a preview; production keeps every one of them, so
# the name must never be anything else.
is_preview_dir() {
  [[ $1 =~ ^pr-[0-9]+$ ]]
}

if [[ -n $preview_dir ]] && ! is_preview_dir "$preview_dir"; then
  fail "Not a PR number: ${preview_dir#pr-}"
fi
if [[ -n $build_dir ]]; then
  [[ -f $build_dir/index.html ]] || fail "No site build at $build_dir: it has no index.html"
  build_dir=$(cd "$build_dir" && pwd)
fi
if [[ -n $not_found_page ]]; then
  [[ -f $not_found_page ]] || fail "No 404 page at $not_found_page"
  not_found_page=$(cd "$(dirname "$not_found_page")" && pwd)/$(basename "$not_found_page")
fi
if [[ $mode == production ]]; then
  [[ $custom_domain =~ ^[a-z0-9.-]+$ ]] || fail "Not a custom domain: $custom_domain"
  shopt -s nullglob
  for entry in "$build_dir"/pr-*; do
    if is_preview_dir "$(basename "$entry")"; then
      fail "The build has a $(basename "$entry") entry, which would be taken for a preview"
    fi
  done
  shopt -u nullglob
fi

# Rewrites the checkout at $1 for this mode.
stage() {
  local site=$1 entry name
  case "$mode" in
    production)
      shopt -s nullglob dotglob
      for entry in "$site"/*; do
        name=$(basename "$entry")
        if [[ $name == .git ]] || { [[ -d $entry ]] && is_preview_dir "$name"; }; then
          continue
        fi
        rm -rf "$entry"
      done
      shopt -u nullglob dotglob
      cp -R "$build_dir"/. "$site"/
      printf '%s\n' "$custom_domain" > "$site/CNAME"
      : > "$site/.nojekyll"
      cp "$not_found_page" "$site/404.html"
      ;;
    preview)
      rm -rf "${site:?}/$preview_dir"
      mkdir "$site/$preview_dir"
      cp -R "$build_dir"/. "$site/$preview_dir"/
      rm -f "$site/$preview_dir/CNAME"
      [[ -e $site/.nojekyll ]] || : > "$site/.nojekyll"
      if [[ ! -e $site/CNAME || ! -e $site/404.html ]]; then
        cp "$not_found_page" "$site/404.html"
      fi
      ;;
    teardown)
      rm -rf "${site:?}/$preview_dir"
      ;;
  esac
}

# Checks the staged checkout at $1 holds what Pages needs to serve this mode.
check_staged() {
  local site=$1 file
  local required=()
  case "$mode" in
    production) required=(index.html 404.html CNAME .nojekyll) ;;
    preview) required=("$preview_dir/index.html" 404.html .nojekyll) ;;
    teardown) return 0 ;;
  esac
  for file in "${required[@]}"; do
    [[ -e $site/$file ]] || fail "The staged branch is missing $file"
  done
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export GIT_AUTHOR_NAME='github-actions[bot]'
export GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com'
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME
export GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL

# One attempt: rewrite the branch's current tip and push it under a lease on
# that tip. Returns 3 when the lease was lost, so the caller retries.
publish_once() {
  local site=$work/site tip='' status=0 tree commit output
  rm -rf "$site"
  git -c init.defaultBranch=pages init -q "$site"
  # The fetch below may hand its housekeeping to a detached `git gc --auto`,
  # which keeps writing under $site/.git after this function returns and
  # fails the EXIT trap's `rm -rf` with "Directory not empty". A checkout this
  # short-lived needs no housekeeping.
  git -C "$site" config gc.auto 0
  git ls-remote --exit-code --heads "$PAGES_REMOTE" "$PAGES_BRANCH" > /dev/null || status=$?
  case "$status" in
    0)
      git -C "$site" fetch -q --depth 1 "$PAGES_REMOTE" "refs/heads/$PAGES_BRANCH"
      tip=$(git -C "$site" rev-parse FETCH_HEAD)
      git -C "$site" checkout -q --detach FETCH_HEAD
      ;;
    2)
      if [[ $mode == teardown ]]; then
        echo "No $PAGES_BRANCH branch, so no $preview_dir to remove"
        return 0
      fi
      echo "No $PAGES_BRANCH branch yet; creating it"
      ;;
    *) fail "Could not read the $PAGES_BRANCH branch" ;;
  esac

  stage "$site"
  check_staged "$site"
  git -C "$site" add -A
  if [[ -n $tip ]] && git -C "$site" diff --cached --quiet "$tip"; then
    echo "$PAGES_BRANCH already holds this $mode"
    return 0
  fi
  tree=$(git -C "$site" write-tree)
  commit=$(git -C "$site" commit-tree "$tree" -m "$commit_message")
  if output=$(git -C "$site" push -q --force-with-lease="refs/heads/$PAGES_BRANCH:$tip" \
    "$PAGES_REMOTE" "$commit:refs/heads/$PAGES_BRANCH" 2>&1); then
    echo "Published $mode${preview_dir:+ ($preview_dir)} to $PAGES_BRANCH as $commit"
    return 0
  fi
  echo "$output" >&2
  # Refused because another deploy moved the branch since it was read (the
  # lease, or the server's own compare-and-swap, lost) is worth a retry on the
  # new tip; refused with the branch where it was (a bad token, say) is not.
  [[ $(git ls-remote --heads "$PAGES_REMOTE" "$PAGES_BRANCH" | cut -f1) != "$tip" ]] ||
    fail "Could not push to $PAGES_BRANCH"
  return 3
}

for attempt in 1 2 3 4 5; do
  # In a subshell outside any `||`, so `set -e` still stops it at the first
  # failing command.
  set +e
  (
    set -e
    publish_once
  )
  status=$?
  set -e
  [[ $status -eq 3 ]] || exit "$status"
  echo "$PAGES_BRANCH moved while publishing (attempt $attempt); retrying on its new tip"
  sleep $((attempt * 2))
done
fail "Could not publish to $PAGES_BRANCH: it kept moving"
