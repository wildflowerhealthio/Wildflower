#!/usr/bin/env bash
# Pre-flight for the Google Play upload of the Android Tauri release: prove the
# upload key can sign the bundle and the service account key is one the upload
# can authenticate with BEFORE the long compile, and name the exact input at
# fault when they can't. Gradle's own "Keystore was tampered with, or password
# was incorrect" arrives at the very end of the build and says neither which
# input nor which of the two it means.
#
# What the inputs are and where they come from: docs/Rust/Android Release
# Signing Explanation.md.
#
# Run it anywhere with a JDK's keytool, openssl and python3, with the same
# environment, to vet credentials before storing them:
#
#   ANDROID_UPLOAD_KEYSTORE="$(base64 < upload.jks)" \
#   ANDROID_UPLOAD_KEYSTORE_PASSWORD='<password>' \
#   ANDROID_UPLOAD_KEY_ALIAS=upload \
#   PLAY_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" \
#     ./scripts/checks/android-play-preflight.sh
#
# Exit 0 when the inputs can sign and upload a bundle; exit 1 otherwise.
set -euo pipefail

# GitHub Actions turns these into clickable annotations; plain text elsewhere.
fail() { echo "::error::$*" >&2; exit 1; }

# A tool's output file as one line, for quoting inside an error.
one_line() { tr '\n' ' ' < "$1" | sed 's/ *$//'; }

# Why keytool refused a keystore, from what it printed. A wrong password and a
# file that is not a keystore at all have different fixes, and keytool words
# each differently by store type — "keystore password was incorrect" for
# PKCS12, "Keystore was tampered with, or password was incorrect" for JKS —
# so each spelling maps to one answer. Args: keytool's output. Echoes
# password | format | other.
keytool_failure_kind() {
  case "$1" in
    *"password was incorrect"*) echo password ;;
    *"Unrecognized keystore format"*|*"Invalid keystore format"*) echo format ;;
    *) echo other ;;
  esac
}

# The entry type `keytool -list -alias` reports for one alias, e.g. "upload,
# 1 Jan 2026, PrivateKeyEntry,". Only a PrivateKeyEntry can sign; a
# trustedCertEntry holds the certificate alone. Args: keytool's listing.
# Echoes private-key | certificate | other.
keystore_entry_kind() {
  case "$1" in
    *PrivateKeyEntry*) echo private-key ;;
    *trustedCertEntry*) echo certificate ;;
    *) echo other ;;
  esac
}

# The service account's email from its JSON key, the identity that has to be
# invited in Play Console. Fails, naming the problem on stderr, when the JSON
# is not a service account key. Args: the key file.
service_account_email() {
  python3 - "$1" <<'PY'
import json, sys

try:
    with open(sys.argv[1]) as handle:
        key = json.load(handle)
except ValueError as error:
    sys.exit('is not JSON ({})'.format(error))
if not isinstance(key, dict):
    sys.exit('is JSON but not an object')
if key.get('type') != 'service_account':
    sys.exit("has type '{}', not 'service_account'".format(key.get('type')))
for field in ('client_email', 'private_key'):
    if not key.get(field):
        sys.exit('has no {}'.format(field))
print(key['client_email'])
PY
}

# Sourcing defines the helpers above and stops, so
# scripts/checks/android-play-preflight.test.ts can exercise them directly.
(return 0 2>/dev/null) && return 0

keystore="${ANDROID_UPLOAD_KEYSTORE:-}"
keystore_password="${ANDROID_UPLOAD_KEYSTORE_PASSWORD:-}"
key_alias="${ANDROID_UPLOAD_KEY_ALIAS:-}"
service_account="${PLAY_SERVICE_ACCOUNT_JSON:-}"

# These arrive from GitHub Actions `vars.*` as well as `secrets.*`, and an
# unset *variable* interpolates to an empty string with no warning at all —
# so an absent one is indistinguishable from a set-but-empty one here, and
# both have to be rejected by name.
[[ -n "$keystore" ]] || fail "ANDROID_UPLOAD_KEYSTORE is empty. Without it the release build is unsigned, and Google Play rejects an unsigned bundle only after the whole build."
[[ -n "$keystore_password" ]] || fail "ANDROID_UPLOAD_KEYSTORE_PASSWORD is empty."
[[ -n "$key_alias" ]] || fail "ANDROID_UPLOAD_KEY_ALIAS is empty. Set the variable in the android-play environment to the upload key's alias."
[[ -n "$service_account" ]] || fail "PLAY_SERVICE_ACCOUNT_JSON is empty. Store the JSON key of the service account that has access in Play Console."
# keystore.properties is a Java properties file: a backslash in the password
# starts an escape there, so the build would read a different password from
# the one checked here.
[[ "$keystore_password" != *\\* ]] || fail "ANDROID_UPLOAD_KEYSTORE_PASSWORD contains a backslash, which keystore.properties reads as an escape. Choose a password without one."

for tool in keytool openssl python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not on the PATH."
done

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
# keytool reads the password from this variable by name (`:env`), so it never
# reaches a command line.
export ANDROID_UPLOAD_KEYSTORE_PASSWORD="$keystore_password"

# ------------------------------------------------------------------ keystore

if ! printf '%s' "$keystore" | base64 --decode > "$workdir/upload.jks" 2>/dev/null; then
  fail "ANDROID_UPLOAD_KEYSTORE is not valid base64. Store the keystore as \`base64 < upload.jks\` output."
fi

if ! keytool -list -keystore "$workdir/upload.jks" \
  -storepass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD > "$workdir/list.out" 2>&1; then
  output="$(one_line "$workdir/list.out")"
  case "$(keytool_failure_kind "$output")" in
    password) fail "ANDROID_UPLOAD_KEYSTORE_PASSWORD does not open ANDROID_UPLOAD_KEYSTORE: $output" ;;
    format) fail "ANDROID_UPLOAD_KEYSTORE decodes, but not to a keystore: $output. Store the .jks or .p12 itself, base64-encoded." ;;
    *) fail "keytool could not read ANDROID_UPLOAD_KEYSTORE: $output" ;;
  esac
fi

if ! keytool -list -keystore "$workdir/upload.jks" -alias "$key_alias" \
  -storepass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD > "$workdir/alias.out" 2>&1; then
  # Each entry's line starts "<alias>, <date>, <entry type>,"; the date has a
  # comma of its own, so the alias is what precedes the first one.
  aliases="$(grep -E '(PrivateKeyEntry|trustedCertEntry|SecretKeyEntry),' "$workdir/list.out" | sed 's/, .*//; s/^/  /' || true)"
  fail "ANDROID_UPLOAD_KEYSTORE has no entry named '$key_alias' (ANDROID_UPLOAD_KEY_ALIAS). It holds:${aliases:+$'\n'}${aliases:-  (no entries)}"
fi

if [[ "$(keystore_entry_kind "$(< "$workdir/alias.out")")" != private-key ]]; then
  fail "'$key_alias' in ANDROID_UPLOAD_KEYSTORE is not a private key entry, so it cannot sign. $(one_line "$workdir/alias.out")"
fi

# keystore.properties gives Gradle one password for the store and the key. A
# certificate request needs the private key itself, so it proves that password
# opens the key too — a JKS store can carry a key password of its own.
if ! keytool -certreq -keystore "$workdir/upload.jks" -alias "$key_alias" \
  -storepass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD \
  -keypass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD \
  -file "$workdir/upload.csr" > "$workdir/certreq.out" 2>&1; then
  fail "ANDROID_UPLOAD_KEYSTORE_PASSWORD opens the keystore but not the key '$key_alias': $(one_line "$workdir/certreq.out"). The build signs with one password for both; give the key the store's password."
fi

keytool -exportcert -rfc -keystore "$workdir/upload.jks" -alias "$key_alias" \
  -storepass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD -file "$workdir/upload.pem" >/dev/null 2>&1
if ! openssl x509 -in "$workdir/upload.pem" -noout -checkend 0 >/dev/null; then
  fail "The upload certificate for '$key_alias' expired on $(openssl x509 -in "$workdir/upload.pem" -noout -enddate | sed 's/^notAfter=//'). Request an upload key reset in Play Console."
fi
fingerprint="$(openssl x509 -in "$workdir/upload.pem" -noout -fingerprint -sha256 | sed 's/^.*=//')"
echo "Upload key '$key_alias', certificate SHA-256 $fingerprint."
echo "Play Console shows the upload certificate it expects on the app's App signing page; the two fingerprints must match."

# ----------------------------------------------------------- service account

printf '%s' "$service_account" > "$workdir/service-account.json"
if ! client_email="$(service_account_email "$workdir/service-account.json" 2>"$workdir/service-account.err")"; then
  fail "PLAY_SERVICE_ACCOUNT_JSON $(< "$workdir/service-account.err"). Store the JSON key downloaded for the service account in Google Cloud → IAM & Admin → Service Accounts → Keys."
fi
echo "Service account: $client_email"

echo "checks/android-play-preflight: OK — upload key '$key_alias' and service account $client_email."
