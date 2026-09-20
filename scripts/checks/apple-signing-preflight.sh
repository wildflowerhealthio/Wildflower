#!/usr/bin/env bash
# Pre-flight for the macOS Tauri release: prove the Apple signing secrets can
# sign BEFORE the ~20 min universal compile. Imports APPLE_CERTIFICATE into a
# throwaway keychain and resolves APPLE_SIGNING_IDENTITY with
# `security find-identity -v -p codesigning`, the lookup the Tauri bundler
# performs at the end of `tauri build` — so the "failed to resolve signing
# identity" that would otherwise end the build is reported here, with the
# certificate names the .p12 actually holds. Also rejects anything but a
# "Developer ID Application" cert, since notarization refuses the rest.
# When notarization credentials (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID)
# are set, validates them against the notary service so an expired or
# revoked app-specific password fails here, not after the ~20 min build.
#
# Called by .github/workflows/tauri-release-publish.yml; run it on any Mac
# with the same env vars to vet a new .p12 before storing it as a secret:
#
#   APPLE_CERTIFICATE="$(base64 -i devid.p12)" \
#   APPLE_CERTIFICATE_PASSWORD='<export password>' \
#   APPLE_SIGNING_IDENTITY='Developer ID Application: <name> (<team id>)' \
#     ./scripts/checks/apple-signing-preflight.sh
#
# Exit 0 when the identity resolves or when all three secrets are unset (a
# deliberately unsigned build); exit 1 on any misconfiguration.
set -euo pipefail

# GitHub Actions turns these into clickable annotations; plain text elsewhere.
fail() { echo "::error::$*" >&2; exit 1; }
warn() { echo "::warning::$*" >&2; }

# notarytool exits 1 for causes whose fixes are unrelated, so the message has
# to name the right one. Echoes usage | auth | network | unknown.
#
# Order matters: a usage dump lists notarytool's own flags, `[--password
# <password>]` among them, so auth patterns would match one — usage wins.
classify_notary_failure() {
  case "$1" in
    *"Unknown option"*|*"Unexpected argument"*|*"Missing expected argument"*|*"Usage:"*)
      echo usage ;;
    *"HTTP status code: 401"*|*"HTTP status code: 403"*|*"Unable to authenticate"*|\
    *"Invalid credentials"*|*"invalid credentials"*|*"Apple ID or password"*)
      echo auth ;;
    *"Could not connect"*|*"could not be reached"*|*"timed out"*|*"Timed out"*|\
    *"network connection"*|*"HTTP status code: 5"*)
      echo network ;;
    *)
      echo unknown ;;
  esac
}

# Sourcing the script defines the helpers above and stops: that is how
# scripts/checks/apple-signing-preflight.test.ts exercises
# `classify_notary_failure` on a Linux CI box, where nothing below can run.
(return 0 2>/dev/null) && return 0

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "checks/apple-signing-preflight: needs macOS (\`security\`, \`codesign\`) — skipping."
  exit 0
fi

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

# `-v` lists only identities with a private key and a valid trust chain, so an
# expired cert or a missing intermediate CA drops out here too.
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
else
  echo "Validating notarization credentials…"
  # No --page-size: `notarytool history` has no such option, and passing one
  # made this check report a usage error as bad credentials. Only the exit
  # code matters, so the default page is fine to discard. See
  # docs/Rust/Apple Release Signing Explanation.md.
  if ! xcrun notarytool history \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    >/dev/null 2>"$workdir/notary.err"; then
    notary_err="$(tr '\n' ' ' < "$workdir/notary.err")"
    case "$(classify_notary_failure "$notary_err")" in
      usage)
        fail "This check invoked notarytool incorrectly, so the credentials were never tested — fix the command in scripts/checks/apple-signing-preflight.sh, not the APPLE_* secrets. notarytool said: $notary_err"
        ;;
      auth)
        fail "Notarization credentials rejected by Apple (APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID). Generate a new app-specific password at appleid.apple.com and update the APPLE_PASSWORD secret. notarytool said: $notary_err"
        ;;
      network)
        # A blip reaching Apple is not a bad secret, and failing the release
        # for one wastes the whole build. tauri-action notarizes for real
        # later; let that be the arbiter.
        warn "Could not reach the notary service, so the credentials are unverified — continuing. notarytool said: $notary_err"
        ;;
      *)
        fail "notarytool failed for a reason this check does not recognise. The credentials may or may not be at fault. notarytool said: $notary_err"
        ;;
    esac
  else
    echo "Notarization credentials OK."
  fi
fi

echo "checks/apple-signing-preflight: OK — APPLE_SIGNING_IDENTITY resolves to '$matched_name'."
