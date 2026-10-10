#!/usr/bin/env bash
# Creates or renews every Apple signing credential the Tauri release needs, and
# stores each channel's in its own GitHub Actions environment for
# .github/workflows/tauri-release-publish.yml to read. Run by hand on a Mac by
# the team's Account Holder; CI never runs it. Which channel needs which
# certificate, and why: docs/Rust/Apple Release Signing Explanation.md. Steps
# for running it: docs/Rust/Apple Signing Sync How-To.md.
#
#   APP_STORE_CONNECT_ISSUER_ID=<issuer id> \
#     ./scripts/release/apple-signing-sync.sh [--dry-run] [--channel <channel>]…
#
# Channels are ios, macos-appstore and macos-direct; with no --channel, all
# three. The key is an Admin-role *team* App Store Connect API key, read from
# APP_STORE_CONNECT_ADMIN_KEY_PATH, or else the one AuthKey_<key id>.p8 in
# WILDFLOWER_SIGNING_DIR; its id is read from that file name. It never leaves
# the Mac.
#
# Each certificate kind has one persistent private key in WILDFLOWER_SIGNING_DIR
# (default ~/.wildflower-signing), generated on first use. A listed certificate
# made from that key is reused until it is within WILDFLOWER_SIGNING_RENEWAL_DAYS
# (default 30) of expiry, then a new one is made from the same key. Nothing is
# ever revoked: when Apple refuses a new certificate because the team is at its
# cap, the existing ones are listed for you to revoke by hand.
#
# Each channel's credentials pass that channel's own preflight from
# scripts/checks/ before anything is written to GitHub; a channel that fails
# is left untouched there while the others carry on.
#
# --dry-run lists, generates local keys and builds and checks the .p12s it can,
# but creates and deletes nothing at Apple and writes nothing to GitHub — it
# says what it would have.
#
# Exit 0 when every selected channel was stored (or would have been); 1
# otherwise.
set -euo pipefail

fail() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

# The JWT, App Store Connect JSON and reuse decisions live in the library
# because that is what the Linux test suite can exercise.
# shellcheck source=./apple-signing-sync-lib.sh
source "${BASH_SOURCE[0]%/*}/apple-signing-sync-lib.sh"

# Sourcing defines the helpers above and stops, so
# scripts/release/apple-signing-sync.test.ts can check the wiring on a Linux
# CI box where nothing below can run.
(return 0 2>/dev/null) && return 0

usage() {
  sed -n 's/^#   //p' "${BASH_SOURCE[0]}" | head -n 2 >&2
  exit "${1:-1}"
}

dry_run=false
channels=""
while (( $# > 0 )); do
  case "$1" in
    --dry-run) dry_run=true ;;
    --channel)
      (( $# > 1 )) || usage
      channel_environment "$2" >/dev/null || fail "Unknown channel '$2'. Pick ios, macos-appstore or macos-direct."
      channels+=" $2"
      shift
      ;;
    -h|--help) usage 0 ;;
    *) usage ;;
  esac
  shift
done
channels="${channels:- ios macos-appstore macos-direct} "
selected() { [[ "$channels" == *" $1 "* ]]; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "apple-signing-sync needs macOS: each channel's preflight imports its .p12 with \`security\`."
fi
for tool in gh openssl python3 curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not on the PATH."
done

repo_root="$(cd "${BASH_SOURCE[0]%/*}/../.." && pwd)"
signing_dir="${WILDFLOWER_SIGNING_DIR:-$HOME/.wildflower-signing}"
renewal_days="${WILDFLOWER_SIGNING_RENEWAL_DAYS:-30}"
issuer_id="${APP_STORE_CONNECT_ISSUER_ID:-}"
[[ -n "$issuer_id" ]] || fail "APP_STORE_CONNECT_ISSUER_ID is empty. It is shown above the key list at App Store Connect → Users and Access → Integrations."
[[ "$renewal_days" =~ ^[0-9]+$ ]] || fail "WILDFLOWER_SIGNING_RENEWAL_DAYS must be a whole number of days."
if [[ -n "${APP_STORE_CONNECT_ADMIN_KEY_PATH:-}" ]]; then
  key_path="$APP_STORE_CONNECT_ADMIN_KEY_PATH"
  [[ -f "$key_path" ]] || fail "No App Store Connect key at $key_path."
else
  key_paths=()
  for candidate in "$signing_dir"/AuthKey_*.p8; do
    [[ -f "$candidate" ]] && key_paths+=("$candidate")
  done
  case "${#key_paths[@]}" in
    0) fail "No AuthKey_<key id>.p8 in $signing_dir. Create an Admin-role team key at App Store Connect → Users and Access → Integrations and download it there, or set APP_STORE_CONNECT_ADMIN_KEY_PATH." ;;
    1) key_path="${key_paths[0]}" ;;
    *) fail "More than one App Store Connect key in $signing_dir (${key_paths[*]##*/}). Remove the ones not in use or set APP_STORE_CONNECT_ADMIN_KEY_PATH." ;;
  esac
fi
key_id="$(asc_key_id_from_path "$key_path")" ||
  fail "$key_path is not named AuthKey_<key id>.p8, which is where the key id is read from. Keep the name App Store Connect downloaded it with."

# The app's bundle identifier is the one Tauri builds with, read rather than
# repeated here.
bundle_identifier="$(asc_json identifier "$repo_root/apps/host/host-app/src-tauri/tauri.conf.json")"

# gh resolves {owner}/{repo} from the checkout it runs in.
cd "$repo_root"
gh auth status >/dev/null 2>&1 || fail "gh is not logged in. Run \`gh auth login\`."
repository="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"

mkdir -p "$signing_dir"
chmod 700 "$signing_dir"
workdir="$(mktemp -d)"
chmod 700 "$workdir"
trap 'rm -rf "$workdir"' EXIT

echo "Syncing Apple signing for $bundle_identifier into $repository (channels:${channels% })."
$dry_run && echo "Dry run: nothing is created or deleted at Apple, nothing is written to GitHub."

# ------------------------------------------------------- App Store Connect

# asc <response file> <method> <path> [body file]: prints the HTTP status and
# writes the response body to the file; 000 on a transport failure. A fresh
# token per request, so a long pause at a prompt cannot outlive one. The token
# reaches curl through a header file, not its command line.
asc() {
  local out="$1" method="$2" path="$3" body="${4:-}"
  local -a body_args=()
  [[ -n "$body" ]] && body_args=(-H 'Content-Type: application/json' --data-binary "@$body")
  printf 'Authorization: Bearer %s\n' \
    "$(asc_jwt "$key_id" "$issuer_id" "$key_path" "$(date +%s)")" > "$workdir/auth.header"
  curl --silent --show-error --max-time 120 -X "$method" \
    -H "@$workdir/auth.header" ${body_args[@]+"${body_args[@]}"} \
    --output "$out" --write-out '%{http_code}' \
    "https://api.appstoreconnect.apple.com$path" || true
}

# asc_or_fail: asc, failing with Apple's own errors on anything but a 2xx.
asc_or_fail() {
  local out="$1" method="$2" path="$3" status
  status="$(asc "$@")"
  if [[ "$status" != 2?? ]]; then
    case "$status" in
      401) fail "App Store Connect rejected the token for $method $path (HTTP 401): check APP_STORE_CONNECT_ISSUER_ID and that $key_path is key $key_id, still active. $(asc_json errors "$out")" ;;
      403) fail "App Store Connect refused $method $path (HTTP 403): certificates and profiles need a team key with the Admin role. $(asc_json errors "$out")" ;;
      *) fail "$method $path answered HTTP $status. $(asc_json errors "$out")" ;;
    esac
  fi
}

list_certificates() {
  asc_or_fail "$workdir/certificates.json" GET '/v1/certificates?limit=200'
}

now="$(date +%s)"
renewal_seconds=$((renewal_days * 86400))
list_certificates

# ---------------------------------------------------------- certificates

# Per-kind results go in $workdir/<kind>/: id, expires, change, and
# cert.der once a certificate is in hand. Files rather than variables because
# bash 3.2 has no associative arrays.
certificate_dir() { echo "$workdir/$1"; }

# Reuses the longest-lived listed certificate of this kind made from our key,
# writing its id, expiry and DER into the kind's directory. Returns 1 when
# there is none.
reuse_listed_certificate() {
  local kind="$1" key_digest="$2" dir id type expires date name content verdict
  dir="$(certificate_dir "$kind")"
  while IFS=$'\t' read -r id type expires date name content; do
    printf '%s' "$content" | base64 --decode > "$dir/candidate.der"
    local matches=false
    [[ "$(public_key_digest certificate "$dir/candidate.der" 2>/dev/null)" == "$key_digest" ]] && matches=true
    verdict="$(certificate_verdict "$matches" "$expires" "$now" "$renewal_days")"
    case "$verdict" in
      reuse)
        mv "$dir/candidate.der" "$dir/cert.der"
        echo "$id" > "$dir/id"
        echo "$date" > "$dir/expires"
        echo "  Reusing $type $id, expires $date."
        return 0
        ;;
      expiring) echo "  $type $id is ours but expires $date, inside the $renewal_days-day renewal window." ;;
    esac
  done < <(asc_json certificates "$workdir/certificates.json" "$(certificate_list_types "$kind")")
  return 1
}

# Lists the team's certificates of this kind for a refusal message: the
# script never revokes one, so this is what to pick from in the portal.
describe_existing_certificates() {
  local kind="$1" id type expires date name content
  echo "Existing $(certificate_label "$kind") certificates — revoke one in the developer portal (Certificates, Identifiers & Profiles) if the team is at its cap:" >&2
  while IFS=$'\t' read -r id type expires date name content; do
    echo "  $id  $type  ${name:-(unnamed)}  expires $date" >&2
  done < <(asc_json certificates "$workdir/certificates.json" "$(certificate_list_types "$kind")")
}

# Reads a Developer ID certificate saved from the portal as
# $signing_dir/developer-id.cer into the kind's directory. Returns 1 when
# there is no such file; fails when it is unusable.
reuse_portal_certificate() {
  local key_digest="$1" dir cer
  dir="$(certificate_dir developer-id)"
  cer="$signing_dir/developer-id.cer"
  [[ -f "$cer" ]] || return 1
  # The portal hands out DER; a PEM copy works too.
  openssl x509 -in "$cer" -inform DER -outform DER -out "$dir/cert.der" 2>/dev/null ||
    openssl x509 -in "$cer" -inform PEM -outform DER -out "$dir/cert.der" 2>/dev/null ||
    fail "$cer is not a certificate."
  [[ "$(public_key_digest certificate "$dir/cert.der")" == "$key_digest" ]] ||
    fail "$cer was not made from $signing_dir/developer-id.csr.pem: its public key is not the one in $signing_dir/developer-id.key.pem."
  openssl x509 -inform DER -in "$dir/cert.der" -noout -checkend "$renewal_seconds" >/dev/null ||
    fail "$cer expires within $renewal_days days. Delete it and re-run to make a new one."
  echo "(portal)" > "$dir/id"
  openssl x509 -inform DER -in "$dir/cert.der" -noout -enddate | sed 's/^notAfter=//' > "$dir/expires"
  echo "  Reusing $cer, expires $(< "$dir/expires")."
}

# Apple does not say whether a team API key may create a Developer ID
# certificate, so when it refuses, the portal makes one from the same CSR. A
# certificate made that way is listed like any other; the saved .cer is the
# fallback for when it is not.
developer_id_from_portal() {
  local key_digest="$1" csr="$2" cer="$signing_dir/developer-id.cer"
  cat >&2 <<INSTRUCTIONS

Make the Developer ID Application certificate in the portal from the same
private key instead:

  1. Open https://developer.apple.com/account/resources/certificates/add
  2. Choose "Developer ID Application" and the G2 Sub-CA, then Continue.
  3. Upload $csr
  4. Download the certificate and save it as $cer
INSTRUCTIONS
  [[ -t 0 ]] || fail "Re-run once $cer is in place."
  read -r -p "Press Enter once it is saved… " _
  list_certificates
  reuse_listed_certificate developer-id "$key_digest" && return 0
  reuse_portal_certificate "$key_digest" ||
    fail "No certificate made from $csr is listed and $cer does not exist."
}

# Leaves a usable certificate of this kind in its directory, or, on a dry run
# that would have to create one, marks it pending.
ensure_certificate() {
  local kind="$1" dir key key_digest csr type status
  dir="$(certificate_dir "$kind")"
  [[ -d "$dir" ]] && return 0
  mkdir "$dir"
  echo "$(certificate_label "$kind") certificate:"

  key="$signing_dir/$kind.key.pem"
  if [[ ! -f "$key" ]]; then
    (umask 077 && openssl genrsa -out "$key" 2048 2>/dev/null)
    echo "  Generated a new private key at $key."
  fi
  key_digest="$(public_key_digest key "$key")"

  if reuse_listed_certificate "$kind" "$key_digest" ||
    { [[ "$kind" == developer-id ]] && reuse_portal_certificate "$key_digest"; }; then
    echo reused > "$dir/change"
    return 0
  fi

  csr="$signing_dir/$kind.csr.pem"
  openssl req -new -key "$key" -subj "/CN=Wildflower $kind" -out "$csr"
  type="$(certificate_create_type "$kind")"
  if $dry_run; then
    echo "  Would create a $type certificate from $csr."
    if [[ "$kind" == developer-id ]]; then
      echo "  If App Store Connect refuses, would ask for one made in the portal from that CSR."
    fi
    echo "would create" > "$dir/change"
    echo "(new)" > "$dir/id"
    echo "(new)" > "$dir/expires"
    touch "$dir/pending"
    return 0
  fi

  asc_json certificate-request "$type" "$csr" > "$dir/request.json"
  status="$(asc "$dir/created.json" POST /v1/certificates "$dir/request.json")"
  if [[ "$status" == 2?? ]]; then
    asc_json data "$dir/created.json" id > "$dir/id"
    asc_json data "$dir/created.json" certificateContent | base64 --decode > "$dir/cert.der"
    asc_json data "$dir/created.json" expirationDate | cut -c1-10 > "$dir/expires"
    echo created > "$dir/change"
    echo "  Created $type $(< "$dir/id"), expires $(< "$dir/expires")."
  elif [[ "$kind" == developer-id ]]; then
    warn "App Store Connect would not create a $type certificate with this key (HTTP $status): $(asc_json errors "$dir/created.json")"
    developer_id_from_portal "$key_digest" "$csr"
    echo "created in portal" > "$dir/change"
  else
    describe_existing_certificates "$kind"
    fail "App Store Connect would not create a $type certificate (HTTP $status): $(asc_json errors "$dir/created.json")"
  fi
}

# Signing identity, team id and a .p12 for a certificate in hand. The .p12
# gets a fresh random password each run: the secret and its password are
# always written together.
#
# `-legacy` where openssl has it: OpenSSL 3's default AES/PBKDF2 encryption
# is unreadable to Security.framework, so a .p12 without it fails `security
# import` on the runner. LibreSSL, macOS's own openssl, only writes the
# legacy kind and has no such flag.
export_certificate() {
  local kind="$1" dir common_name
  dir="$(certificate_dir "$kind")"
  [[ -f "$dir/pending" || -f "$dir/p12.b64" ]] && return 0
  openssl x509 -inform DER -in "$dir/cert.der" -out "$dir/cert.pem"
  common_name="$(common_name_from_subject "$(openssl x509 -in "$dir/cert.pem" -noout -subject -nameopt multiline,-esc_msb,utf8)")"
  [[ -n "$common_name" ]] || fail "Could not read the common name of $(certificate_label "$kind") certificate $(< "$dir/id")."
  printf '%s' "$common_name" > "$dir/identity"
  team_id_from_common_name "$common_name" > "$dir/team" ||
    fail "'$common_name' carries no team id."

  # Read into a variable rather than piped to `grep -q`, whose early exit can
  # kill openssl with SIGPIPE and, under pipefail, read as "no such flag".
  local help
  local -a legacy=()
  help="$(openssl pkcs12 -help 2>&1 || true)"
  [[ "$help" == *-legacy* ]] && legacy=(-legacy)
  openssl rand -hex 24 | tr -d '\n' > "$dir/password"
  openssl pkcs12 -export ${legacy[@]+"${legacy[@]}"} \
    -inkey "$signing_dir/$kind.key.pem" -in "$dir/cert.pem" -name "$common_name" \
    -passout "file:$dir/password" -out "$dir/cert.p12"
  base64 < "$dir/cert.p12" | tr -d '\n' > "$dir/p12.b64"
}

# ----------------------------------------------------------- profiles

# Per-profile results go in $workdir/<profile type>/: content.b64, expires,
# change.
profile_dir() { echo "$workdir/$1"; }

# Leaves an ACTIVE profile of this type, bound to the certificate kind's
# certificate and the app's App ID, in its directory — or marks it pending on
# a dry run that would have to create one.
ensure_profile() {
  local profile_type="$1" kind="$2" dir name certificate_id verdict app_id
  local id state expires date certificate_ids app_id_id
  dir="$(profile_dir "$profile_type")"
  [[ -d "$dir" ]] && return 0
  mkdir "$dir"
  name="$(profile_name "$bundle_identifier" "$profile_type")"
  certificate_id="$(< "$(certificate_dir "$kind")/id")"
  echo "$profile_type profile '$name':"

  asc_or_fail "$dir/app-ids.json" GET "/v1/bundleIds?filter%5Bidentifier%5D=$(asc_json query "$bundle_identifier")&limit=200"
  read -r verdict app_id < <(asc_json app-id "$dir/app-ids.json" "$bundle_identifier" "$(profile_bundle_platforms "$profile_type")")
  case "$verdict" in
    found) ;;
    missing) fail "No App ID '$bundle_identifier' is registered. Register it under Certificates, Identifiers & Profiles → Identifiers." ;;
    *) fail "App ID '$bundle_identifier' is registered for $app_id, but a $profile_type profile needs one whose platform is $(profile_bundle_platforms "$profile_type" | sed 's/,/ or /'). Add the platform to the App ID under Certificates, Identifiers & Profiles → Identifiers." ;;
  esac

  asc_or_fail "$dir/profiles.json" GET "/v1/profiles?filter%5Bname%5D=$(asc_json query "$name")&include=certificates,bundleId&limit=200"
  local -a replace=()
  while IFS=$'\t' read -r id state expires date certificate_ids app_id_id; do
    local bound_to_certificate=false bound_to_app_id=false
    [[ ",$certificate_ids," == *",$certificate_id,"* ]] && bound_to_certificate=true
    [[ "$app_id_id" == "$app_id" ]] && bound_to_app_id=true
    verdict="$(profile_verdict "$state" "$bound_to_certificate" "$bound_to_app_id" "$expires" "$now" "$renewal_days")"
    if [[ "$verdict" == reuse ]]; then
      asc_json profile-content "$dir/profiles.json" "$id" | tr -d '\n' > "$dir/content.b64"
      echo "$date" > "$dir/expires"
      echo reused > "$dir/change"
      echo "  Reusing $id, expires $date."
      return 0
    fi
    echo "  $id is not reusable ($verdict)."
    replace+=("$id")
  done < <(asc_json profiles "$dir/profiles.json" "$name")

  if $dry_run; then
    local stale
    for stale in ${replace[@]+"${replace[@]}"}; do echo "  Would delete $stale."; done
    echo "  Would create it against App ID $app_id and certificate $certificate_id."
    echo "would create" > "$dir/change"
    echo "(new)" > "$dir/expires"
    touch "$dir/pending"
    return 0
  fi

  local stale status
  for stale in ${replace[@]+"${replace[@]}"}; do
    asc_or_fail "$dir/deleted.json" DELETE "/v1/profiles/$stale"
    echo "  Deleted $stale."
  done
  asc_json profile-request "$name" "$profile_type" "$app_id" "$certificate_id" > "$dir/request.json"
  asc_or_fail "$dir/created.json" POST /v1/profiles "$dir/request.json"
  asc_json data "$dir/created.json" profileContent | tr -d '\n' > "$dir/content.b64"
  asc_json data "$dir/created.json" expirationDate | cut -c1-10 > "$dir/expires"
  echo created > "$dir/change"
  echo "  Created $(asc_json data "$dir/created.json" id), expires $(< "$dir/expires")."
}

# ------------------------------------------------------------- GitHub

# Creates the environment only when it is missing: a PUT also rewrites its
# protection rules, which may have been set by hand since.
ensure_environment() {
  local environment="$1"
  gh api "repos/{owner}/{repo}/environments/$environment" --silent 2>/dev/null && return 0
  gh api -X PUT "repos/{owner}/{repo}/environments/$environment" --silent
  echo "  Created environment $environment."
}

# store <environment> secret|variable <name> <file>: values go to gh on stdin,
# never on its command line.
store() {
  local environment="$1" kind="$2" name="$3" file="$4"
  if $dry_run; then
    echo "  Would set $kind $name in $environment."
  else
    gh "$kind" set "$name" --env "$environment" < "$file" >/dev/null
    echo "  Set $kind $name in $environment."
  fi
}

# --------------------------------------------------------------- channels

failed_channels=""
summary="$workdir/summary.tsv"
printf 'Channel\tCertificate\tCertificate id\tExpires\tProfile expires\tChanged\n' > "$summary"

# summarize <channel> <kind> <profile type or -> <stored status>
summarize() {
  local channel="$1" kind="$2" profile_type="$3" stored="$4" dir profile_expires=- changed
  dir="$(certificate_dir "$kind")"
  changed="certificate $(< "$dir/change")"
  if [[ "$profile_type" != - ]]; then
    profile_expires="$(< "$(profile_dir "$profile_type")/expires")"
    changed+=", profile $(< "$(profile_dir "$profile_type")/change")"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$channel" "$(certificate_label "$kind")" \
    "$(< "$dir/id")" "$(< "$dir/expires")" "$profile_expires" "$changed, $stored" >> "$summary"
}

# Whether everything a channel needs exists, so its preflight can run. Args:
# the certificate kinds and profile type it needs. Echoes the summary status
# and returns 1 when a dry run would have had to create one.
channel_ready() {
  local item
  for item in "$@"; do
    [[ -f "$workdir/$item/pending" ]] && { echo "not stored: dry run, would create"; return 1; }
  done
  return 0
}

# Runs a preflight in a subshell holding the channel's inputs, so they reach it
# through its environment and never its command line.
preflight() {
  local channel="$1" script="$2"
  echo "Preflight for $channel:"
  if ! ( "${@:3}" && "$repo_root/scripts/checks/$script" ); then
    warn "$channel failed its preflight, so nothing was written for it."
    failed_channels+=" $channel"
    return 1
  fi
}

# The one way a preflight's inputs are set: exports every NAME=file pair,
# reading the value from the file.
with_inputs() {
  local pair
  for pair in "$@"; do
    export "${pair%%=*}=$(< "${pair#*=}")"
  done
}

sync_ios() {
  local environment=apple-ios cert profile status
  ensure_certificate distribution
  ensure_profile IOS_APP_STORE distribution
  cert="$(certificate_dir distribution)"
  profile="$(profile_dir IOS_APP_STORE)"
  if ! status="$(channel_ready distribution IOS_APP_STORE)"; then
    summarize ios distribution IOS_APP_STORE "$status"
    return 0
  fi
  export_certificate distribution
  printf '%s' "$bundle_identifier" > "$workdir/bundle-identifier"
  if ! preflight ios apple-ios-signing-preflight.sh with_inputs \
    "IOS_CERTIFICATE=$cert/p12.b64" \
    "IOS_CERTIFICATE_PASSWORD=$cert/password" \
    "IOS_MOBILE_PROVISION=$profile/content.b64" \
    "APPLE_DEVELOPMENT_TEAM=$cert/team" \
    "BUNDLE_IDENTIFIER=$workdir/bundle-identifier"; then
    summarize ios distribution IOS_APP_STORE "not stored: preflight failed"
    return 0
  fi
  echo "GitHub environment $environment:"
  $dry_run || ensure_environment "$environment"
  store "$environment" secret IOS_CERTIFICATE "$cert/p12.b64"
  store "$environment" secret IOS_CERTIFICATE_PASSWORD "$cert/password"
  store "$environment" variable IOS_PROVISIONING_PROFILE "$profile/content.b64"
  summarize ios distribution IOS_APP_STORE "$($dry_run && echo 'would store' || echo stored)"
}

sync_macos_appstore() {
  local environment=apple-macos-appstore app installer profile status
  ensure_certificate distribution
  ensure_certificate mac-installer
  ensure_profile MAC_APP_STORE distribution
  app="$(certificate_dir distribution)"
  installer="$(certificate_dir mac-installer)"
  profile="$(profile_dir MAC_APP_STORE)"
  if ! status="$(channel_ready distribution mac-installer MAC_APP_STORE)"; then
    summarize macos-appstore distribution MAC_APP_STORE "$status"
    summarize macos-appstore mac-installer MAC_APP_STORE "$status"
    return 0
  fi
  export_certificate distribution
  export_certificate mac-installer
  printf '%s' "$bundle_identifier" > "$workdir/bundle-identifier"
  if ! preflight macos-appstore apple-macos-appstore-preflight.sh with_inputs \
    "MACOS_APPSTORE_CERTIFICATE=$app/p12.b64" \
    "MACOS_APPSTORE_CERTIFICATE_PASSWORD=$app/password" \
    "MACOS_INSTALLER_CERTIFICATE=$installer/p12.b64" \
    "MACOS_INSTALLER_CERTIFICATE_PASSWORD=$installer/password" \
    "MACOS_PROVISIONING_PROFILE=$profile/content.b64" \
    "APPLE_TEAM_ID=$app/team" \
    "BUNDLE_IDENTIFIER=$workdir/bundle-identifier"; then
    summarize macos-appstore distribution MAC_APP_STORE "not stored: preflight failed"
    summarize macos-appstore mac-installer MAC_APP_STORE "not stored: preflight failed"
    return 0
  fi
  echo "GitHub environment $environment:"
  $dry_run || ensure_environment "$environment"
  store "$environment" secret MACOS_APPSTORE_CERTIFICATE "$app/p12.b64"
  store "$environment" secret MACOS_APPSTORE_CERTIFICATE_PASSWORD "$app/password"
  store "$environment" variable MACOS_APPSTORE_SIGNING_IDENTITY "$app/identity"
  store "$environment" secret MACOS_INSTALLER_CERTIFICATE "$installer/p12.b64"
  store "$environment" secret MACOS_INSTALLER_CERTIFICATE_PASSWORD "$installer/password"
  store "$environment" variable MACOS_INSTALLER_SIGNING_IDENTITY "$installer/identity"
  store "$environment" variable MACOS_PROVISIONING_PROFILE "$profile/content.b64"
  status="$($dry_run && echo 'would store' || echo stored)"
  summarize macos-appstore distribution MAC_APP_STORE "$status"
  summarize macos-appstore mac-installer MAC_APP_STORE "$status"
}

# The notarization half of this preflight needs APPLE_ID, APPLE_PASSWORD and
# APPLE_TEAM_ID, which live in repository secrets this script never reads.
# Exported in your shell they are passed through and checked too; otherwise
# the preflight warns that it skipped them, as it does in CI without them.
sync_macos_direct() {
  local environment=apple-macos-direct cert status
  ensure_certificate developer-id
  cert="$(certificate_dir developer-id)"
  if ! status="$(channel_ready developer-id)"; then
    summarize macos-direct developer-id - "$status"
    return 0
  fi
  export_certificate developer-id
  if ! preflight macos-direct apple-signing-preflight.sh with_inputs \
    "APPLE_CERTIFICATE=$cert/p12.b64" \
    "APPLE_CERTIFICATE_PASSWORD=$cert/password" \
    "APPLE_SIGNING_IDENTITY=$cert/identity"; then
    summarize macos-direct developer-id - "not stored: preflight failed"
    return 0
  fi
  echo "GitHub environment $environment:"
  $dry_run || ensure_environment "$environment"
  store "$environment" secret APPLE_CERTIFICATE "$cert/p12.b64"
  store "$environment" secret APPLE_CERTIFICATE_PASSWORD "$cert/password"
  store "$environment" variable APPLE_SIGNING_IDENTITY "$cert/identity"
  summarize macos-direct developer-id - "$($dry_run && echo 'would store' || echo stored)"
}

selected ios && sync_ios
selected macos-appstore && sync_macos_appstore
selected macos-direct && sync_macos_direct

echo
column -t -s $'\t' "$summary"

if [[ -n "$failed_channels" ]]; then
  fail "Not stored:$failed_channels. The preflight output above names the input at fault."
fi
