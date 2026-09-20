#!/usr/bin/env bash
# Pre-flight for the TestFlight uploads: prove App Store Connect holds an app
# record for the bundle identifier BEFORE the long compile.
#
# Valid signing inputs do not mean the upload has anywhere to go, and without
# an app record altool fails ~30 minutes in with "Cannot determine the Apple
# ID from Bundle ID". Why a record differs from a Developer portal App ID, and
# why this check is three-valued: "An app record is not an App ID" in
# docs/Rust/Apple Release Signing Explanation.md.
#
# Run it on any Mac with the same environment:
#
#   BUNDLE_IDENTIFIER=io.wildflowerhealth.hostapp \
#   APP_STORE_CONNECT_KEY_ID=<key id> \
#   APP_STORE_CONNECT_ISSUER_ID=<issuer id> \
#     ./scripts/checks/apple-app-record-preflight.sh
#
# The private key is read from ~/.appstoreconnect/private_keys, where the
# workflow's "Set up App Store Connect API key" step writes it.
#
# Exit 0 when the record exists or could not be checked; 1 when App Store
# Connect answered and the record is not in the answer.
set -euo pipefail

# GitHub Actions turns these into clickable annotations; plain text elsewhere.
fail() { echo "::error::$*" >&2; exit 1; }
warn() { echo "::warning::$*" >&2; }

# app_record_verdict lives in the library because that is what the Linux test
# suite can exercise.
# shellcheck source=./apple-signing-lib.sh
source "${BASH_SOURCE[0]%/*}/apple-signing-lib.sh"

# Sourcing defines the helpers above and stops, so
# scripts/checks/apple-app-record-preflight.test.ts can exercise them on a
# Linux CI box where nothing below can run.
(return 0 2>/dev/null) && return 0

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "checks/apple-app-record-preflight: needs macOS (\`xcrun altool\`) — skipping."
  exit 0
fi

bundle_identifier="${BUNDLE_IDENTIFIER:-}"
key_id="${APP_STORE_CONNECT_KEY_ID:-}"
issuer_id="${APP_STORE_CONNECT_ISSUER_ID:-}"

[[ -n "$bundle_identifier" ]] || fail "BUNDLE_IDENTIFIER is empty."
[[ -n "$key_id" ]] || fail "APP_STORE_CONNECT_KEY_ID is empty."
[[ -n "$issuer_id" ]] || fail "APP_STORE_CONNECT_ISSUER_ID is empty."

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# Best-effort from here: every path that does not produce a definite answer
# warns and exits 0, so a check that cannot run never fails a release.
if ! xcrun altool --list-apps \
  --apiKey "$key_id" \
  --apiIssuer "$issuer_id" \
  --output-format json > "$workdir/apps.json" 2> "$workdir/altool.err"; then
  warn "checks/apple-app-record-preflight: \`altool --list-apps\` failed, so the app record could not be checked here — the upload will report it instead: $(tr '\n' ' ' < "$workdir/altool.err")"
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  warn "checks/apple-app-record-preflight: no python3 to read altool's JSON — skipping the app record check."
  exit 0
fi

# Walk the document for bundleId rather than pinning altool's undocumented
# JSON shape; a wrong guess reads as "no apps", which app_record_verdict
# treats as unknown rather than absent.
bundle_ids="$(python3 - "$workdir/apps.json" <<'PY' 2>/dev/null || true
import json, sys

def walk(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == 'bundleId' and isinstance(value, str):
                yield value
            else:
                yield from walk(value)
    elif isinstance(node, list):
        for item in node:
            yield from walk(item)

with open(sys.argv[1]) as handle:
    print('\n'.join(sorted(set(walk(json.load(handle))))))
PY
)"

case "$(app_record_verdict "$bundle_identifier" "$bundle_ids")" in
  present)
    echo "checks/apple-app-record-preflight: OK — App Store Connect has a record for '$bundle_identifier'."
    ;;
  absent)
    fail "App Store Connect has no app record for '$bundle_identifier'. The upload would fail with \"Cannot determine the Apple ID from Bundle ID '$bundle_identifier'\" after the whole build. Create the app at appstoreconnect.apple.com (Apps → + → New App), selecting this bundle identifier and the platform being built. A registered App ID in the Developer portal is not the same thing and does not satisfy this. Records visible to key $key_id: $(tr '\n' ' ' <<< "$bundle_ids")"
    ;;
  *)
    warn "checks/apple-app-record-preflight: App Store Connect returned no app list this check could read, so the app record was not verified — the upload will report it instead."
    ;;
esac
