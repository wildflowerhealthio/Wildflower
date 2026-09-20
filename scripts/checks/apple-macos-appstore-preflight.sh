#!/usr/bin/env bash
# Pre-flight for the macOS TestFlight release: prove the Mac App Store signing
# inputs are usable BEFORE the ~20 min universal compile, and name the exact
# input at fault when they aren't.
#
# This channel is entirely separate from the notarized Developer ID build that
# ships on the GitHub Release, and needs different credentials — see
# docs/Rust/Apple Release Signing Explanation.md. Two certificates are
# involved and they are not interchangeable: an Apple Distribution one signs
# the .app, and a Mac Installer Distribution one signs the .pkg that
# `productbuild` wraps it in. Supplying the Developer ID pair instead is the
# easy mistake, and App Store Connect rejects the upload long after the build.
#
# Run it on any Mac with the same environment to vet credentials before
# storing them:
#
#   MACOS_APPSTORE_CERTIFICATE="$(base64 -i app.p12)" \
#   MACOS_APPSTORE_CERTIFICATE_PASSWORD='<export password>' \
#   MACOS_INSTALLER_CERTIFICATE="$(base64 -i installer.p12)" \
#   MACOS_INSTALLER_CERTIFICATE_PASSWORD='<export password>' \
#   MACOS_PROVISIONING_PROFILE="$(base64 -i profile.provisionprofile)" \
#   APPLE_TEAM_ID=<team id> \
#   BUNDLE_IDENTIFIER=io.wildflowerhealth.hostapp \
#     ./scripts/checks/apple-macos-appstore-preflight.sh
#
# Exit 0 when the inputs can build and upload a TestFlight pkg; 1 otherwise.
set -euo pipefail

# GitHub Actions turns these into clickable annotations; plain text elsewhere.
fail() { echo "::error::$*" >&2; exit 1; }

# Certificate and profile classification is shared with the iOS preflight.
# shellcheck source=./apple-signing-lib.sh
source "${BASH_SOURCE[0]%/*}/apple-signing-lib.sh"

# Sourcing defines the helpers above and stops, so
# scripts/checks/apple-macos-appstore-preflight.test.ts can exercise them on a
# Linux CI box where nothing below can run.
(return 0 2>/dev/null) && return 0

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "checks/apple-macos-appstore-preflight: needs macOS (\`security\`, \`plutil\`) — skipping."
  exit 0
fi

app_certificate="${MACOS_APPSTORE_CERTIFICATE:-}"
app_password="${MACOS_APPSTORE_CERTIFICATE_PASSWORD:-}"
installer_certificate="${MACOS_INSTALLER_CERTIFICATE:-}"
installer_password="${MACOS_INSTALLER_CERTIFICATE_PASSWORD:-}"
provisioning_profile="${MACOS_PROVISIONING_PROFILE:-}"
team_id="${APPLE_TEAM_ID:-}"
bundle_identifier="${BUNDLE_IDENTIFIER:-}"

# GitHub Actions interpolates an unset `vars.*` to an empty string with no
# warning, so an absent input is indistinguishable from a set-but-empty one
# and both have to be rejected by name.
[[ -n "$app_certificate" ]] || fail "MACOS_APPSTORE_CERTIFICATE is empty. It holds the base64 of an Apple Distribution .p12 — not the Developer ID certificate the GitHub Release build uses."
[[ -n "$app_password" ]] || fail "MACOS_APPSTORE_CERTIFICATE_PASSWORD is empty."
[[ -n "$installer_certificate" ]] || fail "MACOS_INSTALLER_CERTIFICATE is empty. The .pkg productbuild wraps the app in needs its own 'Mac Installer Distribution' certificate; the app-signing one cannot sign an installer."
[[ -n "$installer_password" ]] || fail "MACOS_INSTALLER_CERTIFICATE_PASSWORD is empty."
[[ -n "$provisioning_profile" ]] || fail "MACOS_PROVISIONING_PROFILE is empty. It holds the base64 of a Mac App Store provisioning profile, embedded into the bundle as Contents/embedded.provisionprofile."
[[ -n "$team_id" ]] || fail "APPLE_TEAM_ID is empty."

workdir="$(mktemp -d)"
keychain="$workdir/macos-appstore-preflight.keychain-db"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

security create-keychain -p preflight "$keychain"
security unlock-keychain -p preflight "$keychain"

# Imports one base64 .p12 and echoes the quoted common name of the first
# identity in it whose kind matches $4. `-v` lists only identities with a
# private key and a valid trust chain, so an expired certificate or a missing
# intermediate CA drops out here rather than mid-build.
import_and_resolve() {
  local label="$1" cert_b64="$2" password="$3" want_kind="$4"
  local p12="$workdir/$label.p12"

  if ! printf '%s' "$cert_b64" | base64 --decode > "$p12" 2>/dev/null; then
    fail "$label is not valid base64. Store the .p12 as \`base64 -i cert.p12\` output."
  fi
  if ! security import "$p12" -k "$keychain" -P "$password" \
    -T /usr/bin/codesign -T /usr/bin/productbuild -T /usr/bin/security \
    >/dev/null 2>"$workdir/$label.err"; then
    fail "Could not import $label: $(tr '\n' ' ' < "$workdir/$label.err"). Either its password is wrong or the file is not a PKCS#12 export that includes the private key."
  fi

  # productbuild resolves installer identities through `-p basic`; codesign
  # uses `-p codesigning`. An installer certificate is invisible to the latter,
  # so the wrong policy here would report a perfectly good certificate missing.
  local policy=codesigning
  [[ "$want_kind" == mac-installer ]] && policy=basic

  local identities name
  identities="$(security find-identity -v -p "$policy" "$keychain" 2>/dev/null || true)"
  while IFS= read -r line; do
    name="${line#*\"}"
    name="${name%\"*}"
    [[ "$name" == "$line" ]] && continue
    if [[ "$(identity_kind "$name")" == "$want_kind" ]]; then
      echo "$name"
      return 0
    fi
  done <<< "$identities"

  echo "Identities found in $label:" >&2
  sed -n 's/.*"\(.*\)".*/  \1/p' <<< "$identities" >&2 || true
  return 1
}

if ! app_identity="$(import_and_resolve appstore "$app_certificate" "$app_password" distribution)"; then
  fail "MACOS_APPSTORE_CERTIFICATE holds no 'Apple Distribution' certificate (listed above), which is the only kind the Mac App Store accepts for the app itself. A 'Developer ID Application' certificate signs the notarized GitHub Release build and is rejected here."
fi
echo "App signing identity: $app_identity"

if ! installer_identity="$(import_and_resolve installer "$installer_certificate" "$installer_password" mac-installer)"; then
  fail "MACOS_INSTALLER_CERTIFICATE holds no 'Mac Installer Distribution' certificate (listed above). Create one at developer.apple.com as 'Mac Installer Distribution'; a 'Developer ID Installer' certificate is for direct distribution and is rejected by App Store Connect."
fi
echo "Installer signing identity: $installer_identity"

# ------------------------------------------------------- provisioning profile

if ! printf '%s' "$provisioning_profile" | base64 --decode > "$workdir/profile.provisionprofile" 2>/dev/null; then
  fail "MACOS_PROVISIONING_PROFILE is not valid base64. Store it as \`base64 -i profile.provisionprofile\` output."
fi
if ! security cms -D -i "$workdir/profile.provisionprofile" > "$workdir/profile.plist" 2>"$workdir/cms.err"; then
  fail "MACOS_PROVISIONING_PROFILE does not decode as a provisioning profile: $(tr '\n' ' ' < "$workdir/cms.err")."
fi

plist_value() { plutil -extract "$1" raw -o - "$workdir/profile.plist" 2>/dev/null || echo ""; }

profile_name="$(plist_value Name)"
profile_team="$(plist_value 'TeamIdentifier.0')"
profile_expires="$(plist_value ExpirationDate)"
# `|| true` because an absent identifier is reported by the named check
# below, not as an unexplained `set -e` abort.
profile_app_id="$(read_app_identifier plist_value || true)"
provisions_all="$(plist_value ProvisionsAllDevices)"; [[ "$provisions_all" == true ]] || provisions_all=false
get_task_allow="$(plist_value 'Entitlements.get-task-allow')"; [[ "$get_task_allow" == true ]] || get_task_allow=false
has_devices=true; [[ -z "$(plist_value 'ProvisionedDevices.0')" ]] && has_devices=false

echo "Provisioning profile: $profile_name (team $profile_team, expires $profile_expires)"

kind="$(profile_kind "$provisions_all" "$has_devices" "$get_task_allow")"
if [[ "$kind" != app-store ]]; then
  fail "MACOS_PROVISIONING_PROFILE is a '$kind' profile but TestFlight needs a Mac App Store one."
fi

if [[ -n "$profile_team" && "$profile_team" != "$team_id" ]]; then
  fail "MACOS_PROVISIONING_PROFILE belongs to team '$profile_team' but APPLE_TEAM_ID is '$team_id'."
fi

# The profile's application-identifier is "<team id>.<bundle id>", and the
# bundle id half may end in a wildcard.
# An unreadable entitlement and a wrong one have different fixes; see
# "Reading entitlements out of a profile" in the Apple Release Signing doc.
if [[ -z "$profile_app_id" ]]; then
  fail "MACOS_PROVISIONING_PROFILE decodes as a valid profile but carries no application-identifier entitlement this check can read. That is a bug in this script or a profile shape it does not know, not a reason to regenerate the profile."
fi

if [[ -n "$bundle_identifier" ]]; then
  profile_bundle_id="${profile_app_id#*.}"
  if [[ "$profile_bundle_id" != "$bundle_identifier" && "$profile_bundle_id" != *'*' ]]; then
    fail "MACOS_PROVISIONING_PROFILE is for bundle identifier '$profile_bundle_id' but the app's is '$bundle_identifier'. Regenerate the profile against '$bundle_identifier'."
  fi
fi

if [[ -n "$profile_expires" ]]; then
  # `date -j -f` is BSD date; this script is macOS-only so that is safe.
  if expires_epoch="$(date -j -f '%Y-%m-%dT%H:%M:%SZ' "$profile_expires" '+%s' 2>/dev/null)"; then
    if (( expires_epoch <= $(date '+%s') )); then
      fail "MACOS_PROVISIONING_PROFILE expired on $profile_expires. Regenerate it at developer.apple.com."
    fi
  fi
fi

echo "checks/apple-macos-appstore-preflight: OK — '$app_identity' + '$installer_identity' with profile '$profile_name'."
