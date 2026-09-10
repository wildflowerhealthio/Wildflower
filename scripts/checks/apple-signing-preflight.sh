#!/usr/bin/env bash
# Pre-flight for the macOS Tauri release: prove the Apple signing secrets can
# actually sign BEFORE the ~20 min universal compile, not after it.
#
# Mirrors what the Tauri bundler does at the end of `tauri build` (import
# APPLE_CERTIFICATE into a throwaway keychain, then look APPLE_SIGNING_IDENTITY
# up with `security find-identity -v -p codesigning`), so a misconfiguration
# that would end the build with "failed codesign application: failed to
# resolve signing identity" is reported here, in seconds, with the reason:
#
#   - APPLE_CERTIFICATE is not valid base64 / not a PKCS#12 bundle
#   - APPLE_CERTIFICATE_PASSWORD does not open it
#   - the bundle holds no certificate named APPLE_SIGNING_IDENTITY (the real
#     names it does hold are printed so the secret can be corrected)
#   - the identity is not a "Developer ID Application" certificate — an
#     "Apple Development" cert signs, but only for Macs registered to the
#     team, and Apple's notary service rejects it, so a GitHub Release built
#     with one is unusable
#
# Runs on the macOS release runner (.github/workflows/tauri-release-publish.yml)
# and locally on any Mac to validate a freshly exported .p12 before it is
# stored as a secret:
#
#   APPLE_CERTIFICATE="$(base64 -i devid.p12)" \
#   APPLE_CERTIFICATE_PASSWORD='<export password>' \
#   APPLE_SIGNING_IDENTITY='Developer ID Application: <name> (<team id>)' \
#     ./scripts/checks/apple-signing-preflight.sh
#
# Exit 0 when the identity resolves, or when none of the three secrets is set
# (an unsigned build is a deliberate choice, e.g. a fork without a team).
# Exit 1 on any misconfiguration.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "checks/apple-signing-preflight: needs macOS (\`security\`, \`codesign\`) — skipping."
  exit 0
fi

# GitHub Actions turns these into clickable annotations; plain text elsewhere.
fail() { echo "::error::$*" >&2; exit 1; }
warn() { echo "::warning::$*" >&2; }

cert_b64="${APPLE_CERTIFICATE:-}"
cert_password="${APPLE_CERTIFICATE_PASSWORD:-}"
identity="${APPLE_SIGNING_IDENTITY:-}"

if [[ -z "$cert_b64" && -z "$cert_password" && -z "$identity" ]]; then
  warn "APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD and APPLE_SIGNING_IDENTITY are all unset: the macOS bundle will be unsigned and un-notarized."
  exit 0
fi
[[ -n "$cert_b64" ]] || fail "APPLE_CERTIFICATE is unset but the other Apple signing secrets are set."
[[ -n "$cert_password" ]] || fail "APPLE_CERTIFICATE_PASSWORD is unset but the other Apple signing secrets are set."
[[ -n "$identity" ]] || fail "APPLE_SIGNING_IDENTITY is unset but the other Apple signing secrets are set."

workdir="$(mktemp -d)"
keychain="$workdir/preflight.keychain-db"
keychain_password="preflight"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

if ! printf '%s' "$cert_b64" | base64 --decode > "$workdir/cert.p12" 2>/dev/null; then
  fail "APPLE_CERTIFICATE is not valid base64. Store the .p12 as \`base64 -i cert.p12\` output."
fi

security create-keychain -p "$keychain_password" "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"

if ! security import "$workdir/cert.p12" -k "$keychain" -P "$cert_password" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>"$workdir/import.err"; then
  fail "Could not import APPLE_CERTIFICATE: $(tr '\n' ' ' < "$workdir/import.err"). Either APPLE_CERTIFICATE_PASSWORD is wrong or the file is not a PKCS#12 (.p12) export that includes the private key."
fi

# The Tauri bundler resolves the identity from exactly this listing, so this
# is the check that decides the real build's fate. `-v` lists only identities
# with a private key AND a valid trust chain — an expired cert or one whose
# intermediate CA is missing drops out here.
valid_identities="$(security find-identity -v -p codesigning "$keychain")"
echo "Valid code-signing identities in APPLE_CERTIFICATE:"
echo "$valid_identities"

# Same leniency as the bundler: the secret may be the certificate's common
# name or its SHA-1 fingerprint, either of which appears on the listing line.
matched="$(grep -F -- "$identity" <<< "$valid_identities" | head -n 1 || true)"
if [[ -z "$matched" ]]; then
  echo "All certificates in APPLE_CERTIFICATE (including ones without a usable key or trust chain):"
  security find-certificate -a -p "$keychain" \
    | awk -v dir="$workdir" '/BEGIN CERTIFICATE/ { n++ } { print > (dir "/cert-" n ".pem") }'
  for pem in "$workdir"/cert-*.pem; do
    [[ -e "$pem" ]] || continue
    openssl x509 -in "$pem" -noout -subject -enddate | sed 's/^/  /'
  done
  fail "APPLE_SIGNING_IDENTITY does not name a valid code-signing identity in APPLE_CERTIFICATE. It must match one of the quoted names above character for character."
fi

matched_name="${matched#*\"}"
matched_name="${matched_name%\"*}"
case "$matched_name" in
  "Developer ID Application: "*) ;;
  *) fail "APPLE_SIGNING_IDENTITY resolves to a '${matched_name%%:*}' certificate but a GitHub Release needs a 'Developer ID Application' one: any other kind only runs on Macs registered to the team and is rejected by notarization." ;;
esac

if [[ -z "${APPLE_ID:-}" || -z "${APPLE_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
  warn "APPLE_ID, APPLE_PASSWORD or APPLE_TEAM_ID is unset: the bundle will be signed but not notarized, so Gatekeeper will refuse to open it on other Macs."
fi

echo "checks/apple-signing-preflight: OK — APPLE_SIGNING_IDENTITY resolves to '$matched_name'."
