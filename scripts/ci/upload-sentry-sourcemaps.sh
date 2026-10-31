#!/usr/bin/env bash
# Creates the Sentry release an app's build reports under and uploads the
# build's source maps to the app's own Sentry project, for
# deploy-pages-sites.sh, between an app's build and the push that publishes
# it:
#
#   upload-sentry-sourcemaps.sh <environment> <release> <dsn> <site-dir>
#
# `environment` and `release` are the `VITE_SENTRY_ENVIRONMENT` and
# `VITE_SENTRY_RELEASE` the site was built with, `dsn` its
# `VITE_SENTRY_DSN_<APP>` value, and `site-dir` its build output. The maps
# stay in the build and are published with it.
#
# Needs `SENTRY_AUTH_TOKEN` (a Sentry organization auth token, whose fixed
# `org:ci` scope covers releases and source maps) and `SENTRY_ORG` (the
# organization slug). Without the token, or with an empty DSN (an app whose
# Sentry project does not exist yet), it uploads nothing. sentry-cli is the
# workspace's `@sentry/cli`, so `vp install` must have run.
# `SENTRY_CLI` replaces its path, for tests.
#
# The same sentry-cli calls, with the same arguments, as
# getsentry/action-release makes for one project and one directory.
set -euo pipefail

if [[ $# -ne 4 ]]; then
  sed -n '7p' "$0" >&2
  exit 2
fi
environment=$1 release=$2 dsn=$3 site_dir=$4

# A DSN's path is its project's numeric ID, which sentry-cli takes in place of
# a slug, so the project comes from the same variable the build reads.
project=${dsn##*/}
if [[ -z ${SENTRY_AUTH_TOKEN:-} || -z $project ]]; then
  echo "No Sentry token or project, so no source-map upload"
  exit 0
fi
: "${SENTRY_ORG:?SENTRY_ORG must name the Sentry organization}"
export SENTRY_AUTH_TOKEN SENTRY_ORG

sentry_cli=${SENTRY_CLI:-node_modules/.bin/sentry-cli}

echo "Uploading $site_dir's source maps to Sentry project $project as $release ($environment)"
"$sentry_cli" releases new "$release" -p "$project"
# Uploads from the build that is about to be published: injecting debug IDs
# rewrites the JavaScript, so the files that get published must be the ones
# that carry them. Debug IDs also make the files' URLs irrelevant, so no
# `--url-prefix` is needed, and one upload serves the app's production origin
# and its previews alike. Sentry's GitHub integration is not installed and
# the checkout is shallow, so no commits are set on the release.
"$sentry_cli" sourcemaps inject "$site_dir"
"$sentry_cli" sourcemaps upload -p "$project" --release "$release" --ignore node_modules "$site_dir"
"$sentry_cli" releases deploys "$release" new -e "$environment"
"$sentry_cli" releases finalize "$release"
