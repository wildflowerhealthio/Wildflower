#!/usr/bin/env bash
# Pre-flight for the TestFlight uploads: prove App Store Connect holds an app
# record for the bundle identifier BEFORE the long compile.
#
# Signing credentials being perfect is not enough to upload. `altool` resolves
# the bundle id to the numeric app identifier App Store Connect assigns an app
# record, and with no such record it fails after the build with:
#
#   Cannot determine the Apple ID from Bundle ID '<bundle id>' and platform 'IOS'. (19)
#
# An App ID registered in the Developer portal is a different thing: it is
# enough to build and sign, so the profile checks all pass and the first sign
# of trouble is ~30 minutes in, at the upload. Asking here costs seconds.
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

# app_record_verdict is shared with nothing else today, but it lives in the
# library because it is the part with the branching and the library is what
# the Linux test suite can exercise.
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

# Everything from here to the verdict is best-effort. This check exists to
# turn a 30-minute failure into a 5-second one, and a check that cannot run
# must not become a new way for a release to fail — so every path that does
# not produce a definite answer warns and exits 0.
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

# Walk the whole document for bundleId rather than pinning altool's JSON
# shape: the shape is undocumented and has moved between Xcode releases, and
# a wrong guess here would read as "no apps" — which app_record_verdict
# deliberately treats as unknown rather than absent.
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
