#!/usr/bin/env bash
# Pre-flight for the iOS Tauri release: prove the Apple signing inputs can
# produce an App Store build BEFORE the long compile, and name the exact input
# at fault when they can't — xcodebuild's own "No Accounts" and "No profiles
# for <bundle id> were found" say neither, and arrive minutes in.
#
# Why these particular inputs, and why configuring signing anywhere else does
# not work: docs/Rust/Apple Release Signing Explanation.md.
#
# Run it on any Mac with the same environment to vet credentials before
# storing them:
#
#   IOS_CERTIFICATE="$(base64 -i dist.p12)" \
#   IOS_CERTIFICATE_PASSWORD='<export password>' \
#   IOS_MOBILE_PROVISION="$(base64 -i profile.mobileprovision)" \
#   APPLE_DEVELOPMENT_TEAM=<team id> \
#   BUNDLE_IDENTIFIER=com.example.app \
#     ./scripts/checks/apple-ios-signing-preflight.sh
#
# Exit 0 when the inputs can sign an App Store build; exit 1 otherwise.
set -euo pipefail

# GitHub Actions turns these into clickable annotations; plain text elsewhere.
fail() { echo "::error::$*" >&2; exit 1; }
warn() { echo "::warning::$*" >&2; }

# Apple renamed its certificate kinds but still issues and accepts the old
# names, so both spellings of each kind map to one answer. Echoes
# distribution | development | developer-id | other.
identity_kind() {
  case "$1" in
    "Apple Distribution: "*|"iPhone Distribution: "*) echo distribution ;;
    "Apple Development: "*|"iPhone Developer: "*)     echo development ;;
    "Developer ID Application: "*)                    echo developer-id ;;
    *)                                                echo other ;;
  esac
}

# A .mobileprovision does not state its kind; it is inferred from three keys.
# Order matters: an enterprise profile also omits ProvisionedDevices, so it
# has to be ruled out before the App Store case, or the two look identical.
# Args: provisions_all_devices(true|false) has_provisioned_devices(true|false)
#       get_task_allow(true|false). Echoes enterprise | app-store |
#       development | ad-hoc.
profile_kind() {
  local provisions_all="$1" has_devices="$2" get_task_allow="$3"
  if [[ "$provisions_all" == true ]]; then
    echo enterprise
  elif [[ "$has_devices" == false ]]; then
    echo app-store
  elif [[ "$get_task_allow" == true ]]; then
    echo development
  else
    echo ad-hoc
  fi
}

# Sourcing defines the helpers above and stops, so
# scripts/checks/apple-ios-signing-preflight.test.ts can exercise them on a
# Linux CI box where nothing below can run.
(return 0 2>/dev/null) && return 0

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "checks/apple-ios-signing-preflight: needs macOS (\`security\`, \`plutil\`) — skipping."
  exit 0
fi

certificate="${IOS_CERTIFICATE:-}"
certificate_password="${IOS_CERTIFICATE_PASSWORD:-}"
mobile_provision="${IOS_MOBILE_PROVISION:-}"
team_id="${APPLE_DEVELOPMENT_TEAM:-}"
bundle_identifier="${BUNDLE_IDENTIFIER:-}"

# These arrive from GitHub Actions `vars.*` as well as `secrets.*`, and an
# unset *variable* interpolates to an empty string with no warning at all —
# so an absent one is indistinguishable from a set-but-empty one here, and
# both have to be rejected by name.
[[ -n "$certificate" ]] || fail "IOS_CERTIFICATE is empty. Tauri signs the iOS app only when IOS_CERTIFICATE, IOS_CERTIFICATE_PASSWORD and IOS_MOBILE_PROVISION are all set; without them the build fails with 'No Accounts: Add a new account in Accounts settings'."
[[ -n "$certificate_password" ]] || fail "IOS_CERTIFICATE_PASSWORD is empty. Tauri logs 'Ignoring the certificate...' and falls back to automatic signing when the password is missing."
[[ -n "$mobile_provision" ]] || fail "IOS_MOBILE_PROVISION is empty. Note the name: Tauri reads IOS_MOBILE_PROVISION, not IOS_PROVISIONING_PROFILE — a profile installed into the keychain under any other variable never reaches the build."
[[ -n "$team_id" ]] || fail "APPLE_DEVELOPMENT_TEAM is empty. Set it from the APPLE_TEAM_ID repository variable."

workdir="$(mktemp -d)"
keychain="$workdir/ios-preflight.keychain-db"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

# ---------------------------------------------------------------- certificate

if ! printf '%s' "$certificate" | base64 --decode > "$workdir/cert.p12" 2>/dev/null; then
  fail "IOS_CERTIFICATE is not valid base64. Store the .p12 as \`base64 -i dist.p12\` output."
fi

security create-keychain -p preflight "$keychain"
security unlock-keychain -p preflight "$keychain"

if ! security import "$workdir/cert.p12" -k "$keychain" -P "$certificate_password" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>"$workdir/import.err"; then
  fail "Could not import IOS_CERTIFICATE: $(tr '\n' ' ' < "$workdir/import.err"). Either IOS_CERTIFICATE_PASSWORD is wrong or the file is not a PKCS#12 (.p12) export that includes the private key."
fi

# `-v` lists only identities with a private key and a valid trust chain, so an
# expired certificate or a missing intermediate CA drops out here too.
identities="$(security find-identity -v -p codesigning "$keychain")"
echo "Valid code-signing identities in IOS_CERTIFICATE:"
echo "$identities"

# The quoted common name on each listing line is what Xcode matches against.
signing_identity=""
while IFS= read -r line; do
  name="${line#*\"}"
  name="${name%\"*}"
  [[ "$name" == "$line" ]] && continue
  if [[ "$(identity_kind "$name")" == distribution ]]; then
    signing_identity="$name"
    break
  fi
done <<< "$identities"

if [[ -z "$signing_identity" ]]; then
  found="$(sed -n 's/.*"\(.*\)".*/  \1/p' <<< "$identities")"
  fail "IOS_CERTIFICATE holds no 'Apple Distribution' certificate, which is the only kind App Store submission accepts. It holds:${found:+$'\n'}${found:-  (nothing usable — no private key, or an expired or untrusted certificate)}. Create an Apple Distribution certificate at developer.apple.com and export it as a .p12 including its private key."
fi
echo "Distribution identity: $signing_identity"

# ------------------------------------------------------- provisioning profile

if ! printf '%s' "$mobile_provision" | base64 --decode > "$workdir/profile.mobileprovision" 2>/dev/null; then
  fail "IOS_MOBILE_PROVISION is not valid base64. Store the profile as \`base64 -i profile.mobileprovision\` output."
fi

# A .mobileprovision is a CMS envelope wrapping the plist; unwrap before reading.
if ! security cms -D -i "$workdir/profile.mobileprovision" > "$workdir/profile.plist" 2>"$workdir/cms.err"; then
  fail "IOS_MOBILE_PROVISION does not decode as a provisioning profile: $(tr '\n' ' ' < "$workdir/cms.err")."
fi

plist_value() { plutil -extract "$1" raw -o - "$workdir/profile.plist" 2>/dev/null || echo ""; }

profile_name="$(plist_value Name)"
profile_team="$(plist_value 'TeamIdentifier.0')"
profile_expires="$(plist_value ExpirationDate)"
profile_app_id="$(plist_value 'Entitlements.application-identifier')"
provisions_all="$(plist_value ProvisionsAllDevices)"; [[ "$provisions_all" == true ]] || provisions_all=false
get_task_allow="$(plist_value 'Entitlements.get-task-allow')"; [[ "$get_task_allow" == true ]] || get_task_allow=false
has_devices=true; [[ -z "$(plist_value 'ProvisionedDevices.0')" ]] && has_devices=false

echo "Provisioning profile: $profile_name (team $profile_team, expires $profile_expires)"

kind="$(profile_kind "$provisions_all" "$has_devices" "$get_task_allow")"
if [[ "$kind" != app-store ]]; then
  fail "IOS_MOBILE_PROVISION is a '$kind' profile but \`--export-method app-store-connect\` needs an App Store one. A development profile is what Xcode looks for under automatic signing, and is why the build reports 'No profiles for <bundle id> were found ... matching iOS App Development provisioning profiles'."
fi

if [[ -n "$profile_team" && "$profile_team" != "$team_id" ]]; then
  fail "IOS_MOBILE_PROVISION belongs to team '$profile_team' but APPLE_DEVELOPMENT_TEAM is '$team_id'. Xcode will not use a profile from another team."
fi

# The profile's application-identifier is "<team id>.<bundle id>", and the
# bundle id half may end in a wildcard.
if [[ -n "$bundle_identifier" ]]; then
  profile_bundle_id="${profile_app_id#*.}"
  if [[ "$profile_bundle_id" != "$bundle_identifier" && "$profile_bundle_id" != *'*' ]]; then
    fail "IOS_MOBILE_PROVISION is for bundle identifier '$profile_bundle_id' but the app's is '$bundle_identifier'. They must match, or the profile must be a wildcard one."
  fi
fi

if [[ -n "$profile_expires" ]]; then
  # `date -j -f` is BSD date; this script is macOS-only so that is safe.
  if expires_epoch="$(date -j -f '%Y-%m-%dT%H:%M:%SZ' "$profile_expires" '+%s' 2>/dev/null)"; then
    if (( expires_epoch <= $(date '+%s') )); then
      fail "IOS_MOBILE_PROVISION expired on $profile_expires. Regenerate it at developer.apple.com and update the IOS_PROVISIONING_PROFILE variable."
    fi
  fi
fi

# The profile embeds the certificates it will sign with. A profile and a .p12
# that are each individually valid but unrelated is the failure mode that
# reads as "no signing certificate" with nothing explaining why, so compare
# them here while both are in hand.
identity_sha1="$(sed -n 's/^ *[0-9]*) \([0-9A-F]\{40\}\).*/\1/p' <<< "$identities" | head -n 1)"
profile_fingerprints=""
index=0
while cert_b64="$(plutil -extract "DeveloperCertificates.$index" raw -o - "$workdir/profile.plist" 2>/dev/null)"; do
  [[ -n "$cert_b64" ]] || break
  fingerprint="$(printf '%s' "$cert_b64" | base64 --decode \
    | openssl x509 -inform DER -noout -fingerprint -sha1 2>/dev/null \
    | sed 's/.*=//; s/://g')"
  profile_fingerprints+="$fingerprint"$'\n'
  index=$((index + 1))
done

if [[ -n "$identity_sha1" && -n "$profile_fingerprints" ]]; then
  if ! grep -qiF "$identity_sha1" <<< "$profile_fingerprints"; then
    fail "IOS_MOBILE_PROVISION does not list the certificate in IOS_CERTIFICATE, so the profile cannot sign with it. Both are valid on their own but belong to different certificates — regenerate the profile against '$signing_identity'."
  fi
  echo "Profile lists the distribution certificate."
fi

echo "checks/apple-ios-signing-preflight: OK — '$signing_identity' with App Store profile '$profile_name'."
