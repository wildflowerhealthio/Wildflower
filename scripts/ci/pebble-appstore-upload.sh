#!/usr/bin/env bash
# Uploads a built .pbw to the Pebble app store as a new, UNPUBLISHED release of
# an app that already has a listing there. Tauri Release — Publish runs it once
# per watch app; the release then waits in the store's dashboard until someone
# publishes it by hand. Why this talks to the store's API itself rather than
# running `pebble publish`, and where the refresh token comes from:
# docs/Pebble/App Store Release Explanation.md.
#
#   PEBBLE_APPSTORE_REFRESH_TOKEN=<Firebase refresh token> \
#   RELEASE_NOTES='<plain text>' \
#     ./scripts/ci/pebble-appstore-upload.sh <app.pbw> <version>
#
# It never creates an app listing or a developer account: an app the store
# doesn't know fails the run and says to do the first upload by hand.
#
# Exit 0 once the store accepts the release; 1 on anything else.
set -euo pipefail

# GitHub Actions turns these into annotations; plain text elsewhere.
fail() { echo "::error::$*" >&2; exit 1; }

# Registers a value with the runner so it is redacted from the log. Only under
# Actions: anywhere else the workflow command would print the value itself.
mask() {
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    echo "::add-mask::$1"
  fi
}

# pebble-tool's own Firebase web API key (DEFAULT_FIREBASE_API_KEY in
# pebble_tool/firebase_account.py) and store API. The key is public — it names
# pebble-tool's Firebase project and authorizes nothing by itself.
firebase_api_key="${PEBBLE_FIREBASE_API_KEY:-AIzaSyBZ9Cdvwwv9At2lPmc8TxyyEqSXGXejGvc}"
api_base="${PEBBLE_APPSTORE_API_BASE:-https://appstore-api.repebble.com}"
api_base="${api_base%/}"

pbw="${1:?usage: pebble-appstore-upload.sh <app.pbw> <version>}"
version="${2:?usage: pebble-appstore-upload.sh <app.pbw> <version>}"
refresh_token="${PEBBLE_APPSTORE_REFRESH_TOKEN:-}"
doc='docs/Pebble/App Store Release Explanation.md'

[[ -n "$refresh_token" ]] || fail "PEBBLE_APPSTORE_REFRESH_TOKEN is empty."
[[ -f "$pbw" ]] || fail "No .pbw at $pbw."

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# request <body file> <curl args...>: prints the HTTP status and writes the
# response body to the file. A transport failure prints 000.
request() {
  local out="$1"
  shift
  curl --silent --show-error --max-time 300 \
    --output "$out" --write-out '%{http_code}' "$@" || true
}

# The `error` field the store and Firebase put in a failure, else the start of
# the raw body.
error_of() {
  local message
  message="$(jq -r '.error | if type == "object" then .message else . end // empty' "$1" 2>/dev/null || true)"
  if [[ -z "$message" ]]; then
    message="$(head -c 500 "$1" 2>/dev/null || true)"
  fi
  printf '%s' "${message:-no response body}"
}

# The store keys an app by the UUID in the .pbw's appinfo.json, and the
# release's version is checked against the versionLabel `pebble build` wrote.
appinfo="$(unzip -p "$pbw" appinfo.json 2>/dev/null)" ||
  fail "$pbw has no appinfo.json; is it a .pbw?"
uuid="$(jq -r '.uuid // empty' <<< "$appinfo")"
version_label="$(jq -r '.versionLabel // empty' <<< "$appinfo")"
name="$(jq -r '.longName // .shortName // empty' <<< "$appinfo")"
[[ -n "$uuid" ]] || fail "$pbw's appinfo.json has no uuid."
# `pebble publish` rewrites an uppercase UUID in the .pbw before uploading it;
# this uploads the file as built, so it must already be lowercase. A glob
# spelled out rather than `${uuid,,}`, which macOS's stock bash 3.2 can't
# expand, or a range, which some locales stretch over lowercase.
[[ "$uuid" != *[ABCDEF]* ]] ||
  fail "$pbw's UUID $uuid has uppercase letters; lowercase it in the app's package.json."
[[ "$version_label" == "$version" ]] ||
  fail "$pbw is version ${version_label:-(none)}, not $version."
echo "Uploading ${name:-$uuid} $version ($uuid)."

# Firebase ID tokens last an hour, so the long-lived secret is the refresh
# token, exchanged here the same way pebble-tool refreshes its own login
# (FirebaseAccount._refresh_id_token). Secrets go to curl through files, not
# its command line.
printf '%s' "$refresh_token" > "$workdir/refresh_token"
status="$(request "$workdir/token.json" \
  --data-urlencode 'grant_type=refresh_token' \
  --data-urlencode "refresh_token@$workdir/refresh_token" \
  "https://securetoken.googleapis.com/v1/token?key=$firebase_api_key")"
if [[ "$status" != 2?? ]]; then
  fail "Could not exchange PEBBLE_APPSTORE_REFRESH_TOKEN for an ID token (HTTP $status: $(error_of "$workdir/token.json")). Log in with \`pebble login\` and replace the secret — see $doc."
fi
id_token="$(jq -r '.id_token // empty' "$workdir/token.json" 2>/dev/null || true)"
[[ -n "$id_token" ]] || fail "Firebase answered the refresh without an id_token."
mask "$id_token"
rotated="$(jq -r '.refresh_token // empty' "$workdir/token.json" 2>/dev/null || true)"
if [[ -n "$rotated" ]]; then
  mask "$rotated"
fi
printf 'Authorization: Bearer %s\n' "$id_token" > "$workdir/auth.header"

# The same preflight `pebble publish` runs: the developer account, and the
# store's app ID for each app UUID it owns.
status="$(request "$workdir/me.json" -H "@$workdir/auth.header" \
  "$api_base/api/v1/developer/me")"
if [[ "$status" == 403 && "$(jq -r '.code // empty' "$workdir/me.json" 2>/dev/null)" == DEVELOPER_NOT_LINKED ]]; then
  fail "The account behind PEBBLE_APPSTORE_REFRESH_TOKEN has no Pebble developer account. Upload the app's first release by hand, which creates one — see $doc."
fi
if [[ "$status" != 2?? ]]; then
  fail "GET $api_base/api/v1/developer/me answered HTTP $status: $(error_of "$workdir/me.json")"
fi
app_id="$(jq -r --arg uuid "$uuid" '
  (.app_lookup.by_app_uuid // {}) | to_entries[]
  | select((.key | ascii_downcase) == $uuid) | .value // empty | tostring
' "$workdir/me.json" 2>/dev/null | head -n 1)" ||
  fail "GET $api_base/api/v1/developer/me answered HTTP $status without the app lookup it should carry: $(error_of "$workdir/me.json")"
if [[ -z "$app_id" ]]; then
  fail "The Pebble app store has no app with UUID $uuid (${name:-this app}) under this developer account. CI only adds releases to an existing listing: create the listing by hand with the first release, then re-run this job — see $doc."
fi
[[ "$app_id" =~ ^[A-Za-z0-9_-]+$ ]] || fail "The store gave an unexpected app ID for $uuid: $app_id"
echo "Store app ID: $app_id"

# The release, as `pebble publish` sends it for an existing app, but with
# isPublished false: pebble-tool 5.0.40 sends true whatever its
# `--is-published` flag says. No screenshots, and existing ones are kept.
# `--form-string` so notes starting with `@` or `<` stay text.
status="$(request "$workdir/release.json" -H "@$workdir/auth.header" \
  --form-string "version=$version" \
  --form-string "releaseNotes=${RELEASE_NOTES:-}" \
  --form-string 'isPublished=false' \
  --form-string 'replaceScreenshots=false' \
  --form "pbwFile=@$pbw;type=application/octet-stream" \
  "$api_base/api/dashboard/apps/$app_id/releases")"
if [[ "$status" != 2?? ]]; then
  fail "The store rejected ${name:-$uuid} $version (HTTP $status): $(error_of "$workdir/release.json")"
fi
message="$(jq -r '.message // empty' "$workdir/release.json" 2>/dev/null || true)"
echo "${message:-Release uploaded.}"
echo "::notice::${name:-$uuid} $version is in the Pebble app store as an unpublished release. Publish it from the dashboard: $api_base/dashboard"
