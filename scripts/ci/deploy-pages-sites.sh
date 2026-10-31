#!/usr/bin/env bash
# Builds and publishes a list of Pages sites one after another, or removes a
# PR's previews from them, for the deploy-pages-sites composite action and
# pr-preview.yml's teardown:
#
#   deploy-pages-sites.sh build      # build every site in SITES
#   deploy-pages-sites.sh publish    # publish every site in SITES
#   deploy-pages-sites.sh teardown   # remove pr-<TARGET>/ from every site in SITES
#
# `SITES` is a JSON array of planned sites (`scripts/ci/pages-sites.ts plan
# …`), and `TARGET` is `production` or the PR number whose preview this is.
# Each site is built or published in a process of its own, so one site's
# failure, or its Sentry DSN, never reaches the next: a failed site is
# reported and the rest carry on. `build` and `publish` write the names of
# the sites that failed to `failed` in `GITHUB_OUTPUT` and leave failing the
# job to the caller, once every site has had its turn; `teardown` fails at
# the end itself.
#
# `build` also writes, for the sites that built: `built`, their JSON array,
# for `publish`; and `repositories`, their Pages repositories
# comma-separated, for the App token. It reads `RELEASE` (the commit the
# build reports as) and `VARIABLES` (the repository variables as JSON, where
# each site's `sentryDsnVariable` is looked up), and uploads each app's
# source maps to its own Sentry project with upload-sentry-sourcemaps.sh,
# given `SENTRY_AUTH_TOKEN` and `SENTRY_ORG`.
#
# `publish` and `teardown` push with `PAGES_TOKEN`, an App installation token
# covering every site's Pages repository under wildflowerhealthio. `publish`
# reads `RELEASE` for its commit message, as does `GITHUB_REPOSITORY`.
# `PAGES_REMOTE_BASE` replaces the github.com URL the Pages repositories are
# pushed to, for tests.
set -euo pipefail

# The 404 page every site serves: branding-core's SPA redirect, which each
# app completes with `restoreRedirectedUrl`. Pages reads it, `CNAME` and
# `.nojekyll` only from the branch root, which the production publish writes
# and a preview leaves alone.
not_found_page=slices/branding/branding-core/github-pages/404.html

usage() {
  sed -n '6,8p' "$0" >&2
  exit 2
}

: "${SITES:?SITES must hold the planned sites as JSON}"
: "${TARGET:?TARGET must be production or a PR number}"
[[ $TARGET == production || $TARGET =~ ^[0-9]+$ ]] || {
  echo "::error::Not production or a PR number: $TARGET" >&2
  exit 1
}

environment=$([[ $TARGET == production ]] && echo production || echo staging)
variables=${VARIABLES:-}
[[ -n $variables ]] || variables='{}'

# Reads a field of the site $site (a planned site's JSON).
field() {
  jq -r --arg field "$1" '.[$field]' <<< "$site"
}

pages_remote() {
  local repository=$1
  echo "${PAGES_REMOTE_BASE:-https://x-access-token:${PAGES_TOKEN:?PAGES_TOKEN must hold the Pages App token}@github.com/wildflowerhealthio}/$repository.git"
}

# Builds the one site $site: its package and every workspace package it
# depends on, then the check that the build holds its required files, then,
# for the marketing site's preview, the book at `book/`, then the upload of
# its source maps to its Sentry project.
build_site() {
  local name package build_dir dsn_variable dsn='' sentry_auth_token=${SENTRY_AUTH_TOKEN:-}
  # Only the upload sees the Sentry token, never the build.
  unset SENTRY_AUTH_TOKEN
  name=$(field name)
  package=$(field packageName)
  build_dir=$(field buildDir)
  dsn_variable=$(field sentryDsnVariable)
  # `<package>^...` builds every workspace package the site depends on, in
  # dependency order, but not the site itself. `--cache` replays a package
  # already built, by an earlier site in this job or in the pack cache
  # restored from main, instead of building it again. vp counts every
  # `VITE_*` variable set in a task's fingerprint, so these builds run
  # before the site's Sentry variables are set, as main's `vp run pack` does.
  vp run --cache --filter "$package^..." build

  # The app reads only its own `VITE_SENTRY_DSN_<APP>` (a public identifier,
  # so a repository variable rather than a secret) and reports nothing
  # without one; the shared `VITE_SENTRY_DSN` is left unset, as it is what
  # the Tauri entry's unconsented init reads. Previews report as `staging`,
  # so their traffic filters apart.
  if [[ -n $dsn_variable ]]; then
    dsn=$(jq -r --arg name "$dsn_variable" '.[$name] // ""' <<< "$variables")
    export "$dsn_variable=$dsn"
  fi
  unset VARIABLES
  export VITE_SENTRY_ENVIRONMENT=$environment
  export VITE_SENTRY_RELEASE=${RELEASE:?RELEASE must name the commit built}

  # The site itself, with its Sentry variables. Each build carries its commit
  # as its Sentry release, so the site's own build always misses the cache.
  vp run --cache --filter "$package" build
  node scripts/ci/pages-sites.ts check "$name"
  # The book's `{{#code}}` directives name source by file and symbol, so a
  # PR whose chapters or excerpted code no longer match fails here. Its links
  # name GITHUB_SHA, the commit checked out.
  if [[ $(field includesBook) == true ]]; then
    (cd apps/wildflower-site/book-web && vp run build-book --out "$GITHUB_WORKSPACE/$build_dir/book")
  fi
  if [[ -n $dsn ]]; then
    SENTRY_AUTH_TOKEN=$sentry_auth_token \
      scripts/ci/upload-sentry-sourcemaps.sh "$environment" "$VITE_SENTRY_RELEASE" "$dsn" "$build_dir"
  fi
}

# Publishes the one site $site's build: production at the branch root, or a
# preview in its `pr-<n>/` directory.
publish_site() {
  local repository build_dir site_url domain
  repository=$(field pagesRepository)
  build_dir=$(field buildDir)
  site_url=$(field siteUrl)
  PAGES_REMOTE=$(pages_remote "$repository")
  PAGES_BRANCH=$(field pagesBranch)
  PAGES_COMMIT_MESSAGE="Deploy $GITHUB_REPOSITORY@${RELEASE:?RELEASE must name the commit built} ($([[ $TARGET == production ]] && echo production || echo "pr-$TARGET"))"
  export PAGES_REMOTE PAGES_BRANCH PAGES_COMMIT_MESSAGE
  if [[ $TARGET == production ]]; then
    domain=${site_url#https://}
    scripts/ci/publish-pages-branch.sh production "$build_dir" "${domain%%/*}" "$not_found_page"
  else
    scripts/ci/publish-pages-branch.sh preview "$TARGET" "$build_dir" "$not_found_page"
  fi
}

# Removes the PR's preview from the one site $site's Pages branch.
teardown_site() {
  PAGES_REMOTE=$(pages_remote "$(field pagesRepository)")
  PAGES_BRANCH=$(field pagesBranch)
  PAGES_COMMIT_MESSAGE="Remove the preview of $GITHUB_REPOSITORY#$TARGET"
  export PAGES_REMOTE PAGES_BRANCH PAGES_COMMIT_MESSAGE
  scripts/ci/publish-pages-branch.sh teardown "$TARGET"
}

# The per-site steps run as a child of this script (`build-site`,
# `publish-site`, `teardown-site`), so `set -e` holds inside each, which it
# would not in a function called from an `if`, and nothing one site exports
# reaches the next.
mode=${1:-}
case "$mode" in
  build-site | publish-site | teardown-site)
    site=${2:?}
    "${mode%-site}_site"
    exit 0
    ;;
  build | publish | teardown) ;;
  *) usage ;;
esac

succeeded=()
failed=()
case "$mode" in
  build) action=Build ;;
  publish) action=Publish ;;
  teardown) action='Remove the preview of' ;;
esac
count=$(jq length <<< "$SITES")
for ((i = 0; i < count; i++)); do
  site=$(jq -c ".[$i]" <<< "$SITES")
  name=$(field name)
  echo "::group::$action $name"
  if "$0" "$mode-site" "$site"; then
    succeeded+=("$site")
  else
    failed+=("$name")
    echo "::error::$action $name failed"
  fi
  echo '::endgroup::'
done

if [[ $mode == teardown ]]; then
  if ((${#failed[@]} > 0)); then
    echo "::error::Could not remove the previews of: ${failed[*]}"
    exit 1
  fi
  exit 0
fi

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must name the output file}"
echo "failed=${failed[*]}" >> "$GITHUB_OUTPUT"
if [[ $mode == build ]]; then
  built=$(printf '%s\n' "${succeeded[@]}" | jq -sc .)
  {
    echo "built=$built"
    echo "repositories=$(jq -r '[.[].pagesRepository] | unique | join(",")' <<< "$built")"
  } >> "$GITHUB_OUTPUT"
fi
