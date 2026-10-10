#!/usr/bin/env bash
# Creates the upload key the Android Tauri release signs its Google Play bundle
# with, if there is none yet, and stores it with the Play service account's
# JSON key in the `android-play` GitHub Actions environment. Run by hand by
# someone who administers the repository; CI never runs it. What the key and
# the service account are for, and why: docs/Rust/Android Release Signing
# Explanation.md. Steps for running it, including the Play Console setup it
# cannot do: docs/Rust/Android Signing Sync How-To.md.
#
#   ./scripts/release/android-signing-sync.sh [--dry-run] [--service-account <key.json>]
#
# The service account key is the JSON key downloaded from Google Cloud, read
# from --service-account, or else from play-service-account.json in
# WILDFLOWER_SIGNING_DIR (default ~/.wildflower-signing). It never leaves this
# machine except as the PLAY_SERVICE_ACCOUNT_JSON secret.
#
# The upload key is one persistent keystore in WILDFLOWER_SIGNING_DIR,
# android-upload.jks, with its password beside it in android-upload.password
# and its certificate in android-upload.pem. It is generated on first use and
# reused on every run after: once Play Console has seen it, a new one is
# refused until Google resets the upload key, so it is never replaced here.
#
# The key and the service account pass scripts/checks/android-play-preflight.sh
# before anything is written to GitHub; when they fail, GitHub is left
# untouched.
#
# --dry-run generates the keystore if it is missing and runs the preflight, but
# writes nothing to GitHub — it says what it would have.
#
# Exit 0 when the environment was filled (or would have been); 1 otherwise.
set -euo pipefail

fail() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

usage() {
  sed -n 's/^#   //p' "${BASH_SOURCE[0]}" | head -n 1 >&2
  exit "${1:-1}"
}

dry_run=false
service_account_path=""
while (( $# > 0 )); do
  case "$1" in
    --dry-run) dry_run=true ;;
    --service-account)
      (( $# > 1 )) || usage
      service_account_path="$2"
      shift
      ;;
    -h|--help) usage 0 ;;
    *) usage ;;
  esac
  shift
done

for tool in gh keytool openssl python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not on the PATH."
done

repo_root="$(cd "${BASH_SOURCE[0]%/*}/../.." && pwd)"
signing_dir="${WILDFLOWER_SIGNING_DIR:-$HOME/.wildflower-signing}"
environment=android-play
# The alias Tauri's Android signing guide gives the upload key.
key_alias=upload
keystore="$signing_dir/android-upload.jks"
password_file="$signing_dir/android-upload.password"
certificate="$signing_dir/android-upload.pem"

if [[ -z "$service_account_path" ]]; then
  service_account_path="$signing_dir/play-service-account.json"
  [[ -f "$service_account_path" ]] || fail "No service account key at $service_account_path. Create a JSON key for the Play service account in Google Cloud → IAM & Admin → Service Accounts → Keys, and save it there or pass --service-account <key.json>."
fi
[[ -f "$service_account_path" ]] || fail "No service account key at $service_account_path."

# gh resolves {owner}/{repo} from the checkout it runs in.
cd "$repo_root"
gh auth status >/dev/null 2>&1 || fail "gh is not logged in. Run \`gh auth login\`."
repository="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"

mkdir -p "$signing_dir"
chmod 700 "$signing_dir"
workdir="$(mktemp -d)"
chmod 700 "$workdir"
trap 'rm -rf "$workdir"' EXIT

echo "Syncing Android signing into $repository (environment $environment)."
$dry_run && echo "Dry run: nothing is written to GitHub."

# ---------------------------------------------------------------- upload key

echo "Upload key:"
if [[ -f "$keystore" ]]; then
  [[ -f "$password_file" ]] || fail "$keystore exists but $password_file does not, so the keystore cannot be opened. Restore the password file from the same backup as the keystore."
  echo "  Reusing $keystore."
else
  warn "No upload keystore at $keystore, so a new one is generated. If Play Console already has an upload key for this app, it refuses bundles signed with this one: restore the old keystore and its password file from backup instead, or request an upload key reset in Play Console."
  (umask 077 && openssl rand -hex 24 | tr -d '\n' > "$password_file")
  # keytool reads the password from this variable by name (`:env`), so it
  # never reaches a command line. A PKCS12 keystore (keytool's default) has one
  # password for the store and the key, which is the shape keystore.properties
  # expects. RSA 2048 and 10,000 days are what Android's and Tauri's signing
  # guides use.
  ANDROID_UPLOAD_KEYSTORE_PASSWORD="$(< "$password_file")" \
    keytool -genkeypair -keystore "$keystore" -alias "$key_alias" \
      -keyalg RSA -keysize 2048 -validity 10000 \
      -dname "CN=Wildflower Android upload" \
      -storepass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD \
      -keypass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD >/dev/null 2>&1 ||
    fail "keytool could not generate $keystore."
  chmod 600 "$keystore"
  echo "  Generated a new upload key at $keystore."
fi
# The certificate is what an upload key reset in Play Console asks for.
ANDROID_UPLOAD_KEYSTORE_PASSWORD="$(< "$password_file")" \
  keytool -exportcert -rfc -keystore "$keystore" -alias "$key_alias" \
    -storepass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD -file "$certificate" >/dev/null 2>&1 ||
  fail "Could not read the '$key_alias' certificate out of $keystore with the password in $password_file."

base64 < "$keystore" | tr -d '\n' > "$workdir/keystore.b64"
printf '%s' "$key_alias" > "$workdir/alias"

# ------------------------------------------------------------------ preflight

# Runs in a subshell holding the inputs, so they reach the preflight through
# its environment and never its command line.
echo "Preflight:"
if ! (
  ANDROID_UPLOAD_KEYSTORE="$(< "$workdir/keystore.b64")"
  ANDROID_UPLOAD_KEYSTORE_PASSWORD="$(< "$password_file")"
  ANDROID_UPLOAD_KEY_ALIAS="$key_alias"
  PLAY_SERVICE_ACCOUNT_JSON="$(< "$service_account_path")"
  export ANDROID_UPLOAD_KEYSTORE ANDROID_UPLOAD_KEYSTORE_PASSWORD \
    ANDROID_UPLOAD_KEY_ALIAS PLAY_SERVICE_ACCOUNT_JSON
  "$repo_root/scripts/checks/android-play-preflight.sh"
); then
  fail "Not stored: the preflight output above names the input at fault."
fi

# ------------------------------------------------------------------- GitHub

# Creates the environment only when it is missing: a PUT also rewrites its
# protection rules, which may have been changed by hand since. A new one may
# deploy from main only — the branch every deploy runs on.
ensure_environment() {
  gh api "repos/{owner}/{repo}/environments/$environment" --silent 2>/dev/null && return 0
  printf '%s' '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
    gh api -X PUT "repos/{owner}/{repo}/environments/$environment" --input - --silent
  gh api -X POST "repos/{owner}/{repo}/environments/$environment/deployment-branch-policies" \
    -f name=main -f type=branch --silent
  echo "  Created environment $environment, deploying from main only."
}

# store secret|variable <name> <file>: values go to gh on stdin, never on its
# command line.
store() {
  local kind="$1" name="$2" file="$3"
  if $dry_run; then
    echo "  Would set $kind $name in $environment."
  else
    gh "$kind" set "$name" --env "$environment" < "$file" >/dev/null
    echo "  Set $kind $name in $environment."
  fi
}

echo "GitHub environment $environment:"
$dry_run || ensure_environment
store secret ANDROID_UPLOAD_KEYSTORE "$workdir/keystore.b64"
store secret ANDROID_UPLOAD_KEYSTORE_PASSWORD "$password_file"
store variable ANDROID_UPLOAD_KEY_ALIAS "$workdir/alias"
store secret PLAY_SERVICE_ACCOUNT_JSON "$service_account_path"

echo
echo "Back up $signing_dir somewhere private: the upload key cannot be recovered from GitHub or Google."
