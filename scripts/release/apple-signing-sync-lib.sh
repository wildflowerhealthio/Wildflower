#!/usr/bin/env bash
# Helpers for apple-signing-sync.sh that do not need a Mac: building the App
# Store Connect token, reading its JSON, and deciding what to reuse. Sourced by
# that script.
#
# Nothing here calls Apple, GitHub or `security`; the only tools used are
# openssl, od and python3's standard library, all present on a Linux CI box —
# which is what lets scripts/release/apple-signing-sync-lib.test.ts run them.
#
# Written for macOS's stock bash 3.2: no associative arrays, no `${x,,}`.

# The GitHub environment each Apple channel's credentials are stored in. Args:
# a channel as `--channel` spells it. Echoes the environment name, or returns
# 1 for a channel that does not exist.
channel_environment() {
  case "$1" in
    ios) echo apple-ios ;;
    macos-appstore) echo apple-macos-appstore ;;
    macos-direct) echo apple-macos-direct ;;
    *) return 1 ;;
  esac
}

# The App Store Connect `certificateType` this script creates for each kind of
# certificate. Developer ID is the G2 type: the portal offers only that one for
# new Developer ID Application certificates. Args: a certificate kind.
certificate_create_type() {
  case "$1" in
    distribution) echo DISTRIBUTION ;;
    mac-installer) echo MAC_INSTALLER_DISTRIBUTION ;;
    developer-id) echo DEVELOPER_ID_APPLICATION_G2 ;;
    *) return 1 ;;
  esac
}

# How Apple names each kind of certificate, for messages and the summary.
certificate_label() {
  case "$1" in
    distribution) echo 'Apple Distribution' ;;
    mac-installer) echo 'Mac Installer Distribution' ;;
    developer-id) echo 'Developer ID Application' ;;
    *) return 1 ;;
  esac
}

# Every `certificateType` a reusable certificate of each kind may be listed
# under, comma-separated. A Developer ID certificate made in the portal lists
# as either spelling, depending on when it was made.
certificate_list_types() {
  case "$1" in
    developer-id) echo DEVELOPER_ID_APPLICATION,DEVELOPER_ID_APPLICATION_G2 ;;
    *) certificate_create_type "$1" ;;
  esac
}

# The App ID platforms each profile type can be issued against,
# comma-separated. A UNIVERSAL App ID covers both.
profile_bundle_platforms() {
  case "$1" in
    IOS_APP_STORE) echo IOS,UNIVERSAL ;;
    MAC_APP_STORE) echo MAC_OS,UNIVERSAL ;;
    *) return 1 ;;
  esac
}

# The name of the one profile per type this script owns. Profiles are matched
# by this exact name, so any other profile on the team is never touched.
profile_name() {
  printf 'Wildflower %s %s\n' "$1" "$2"
}

# Decides whether a listed certificate can be kept. Args: key_matches
# (true|false — whether its public key is our persistent key's),
# expires_epoch, now_epoch, renewal_days. Echoes reuse | expiring |
# other-key.
#
# A certificate made from any other key is unusable however long it has left:
# its private key is not in the signing folder, so it cannot go into a .p12.
certificate_verdict() {
  local key_matches="$1" expires_epoch="$2" now_epoch="$3" renewal_days="$4"
  if [[ "$key_matches" != true ]]; then
    echo other-key
  elif (( expires_epoch <= now_epoch + renewal_days * 86400 )); then
    echo expiring
  else
    echo reuse
  fi
}

# Decides whether a profile carrying our exact name can be kept. Args: state
# (ACTIVE | INVALID | …), bound_to_certificate (true|false),
# bound_to_app_id (true|false), expires_epoch, now_epoch, renewal_days.
# Echoes reuse, or the reason it is replaced: inactive | other-certificate |
# other-app-id | expiring.
#
# A renewed certificate is the usual reason for other-certificate: a profile
# lists the certificates it signs with, and the old profile does not list the
# new one.
profile_verdict() {
  local state="$1" bound_to_certificate="$2" bound_to_app_id="$3"
  local expires_epoch="$4" now_epoch="$5" renewal_days="$6"
  if [[ "$state" != ACTIVE ]]; then
    echo inactive
  elif [[ "$bound_to_certificate" != true ]]; then
    echo other-certificate
  elif [[ "$bound_to_app_id" != true ]]; then
    echo other-app-id
  elif (( expires_epoch <= now_epoch + renewal_days * 86400 )); then
    echo expiring
  else
    echo reuse
  fi
}

# The common name out of `openssl x509 -noout -subject -nameopt multiline`
# output, which puts each attribute on its own line so a comma inside the
# organisation name cannot split it.
common_name_from_subject() {
  sed -n 's/^ *commonName *= *//p' <<< "$1" | head -n 1
}

# The team id Apple puts in parentheses at the end of every signing
# certificate's common name, e.g. "Apple Distribution: Name (29QHKJX9V7)".
# Returns 1 when the name carries none.
team_id_from_common_name() {
  local name="$1"
  [[ "$name" =~ \(([A-Z0-9]{10})\)$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

# The key id App Store Connect puts in the name of every API key it hands
# out, AuthKey_<key id>.p8. Args: the key's path. Returns 1 when the file is
# not named that way.
asc_key_id_from_path() {
  local name="${1##*/}"
  [[ "$name" =~ ^AuthKey_([A-Za-z0-9]+)\.p8$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

# base64url without padding, as a JWT spells it. Reads stdin. `tr -d '\n'`
# because GNU base64 wraps and BSD base64 does not.
base64url() {
  base64 | tr '+/' '-_' | tr -d '=\n'
}

# Converts an ECDSA signature from the DER that `openssl dgst -sign` writes
# into the raw r||s that JWS ES256 requires (RFC 7518 §3.4), each half
# left-padded to 32 bytes.
#
# DER stores r and s as signed integers: a half whose top bit is set gains a
# leading 00 byte, and a half with leading zero bytes loses them. Both have to
# be undone, or roughly one token in two is rejected by Apple as a bad
# signature.
#
# Args: the DER signature as lowercase hex. Echoes 128 hex characters, or
# returns 1 when the input is not a DER ECDSA-P256 signature.
der_signature_to_raw() {
  local der="$1" offset=0 raw="" length value
  [[ "$der" =~ ^([0-9a-f]{2})+$ ]] || return 1
  [[ "${der:0:2}" == 30 ]] || return 1
  # A P-256 signature is at most 72 bytes, so the sequence length takes the
  # short form; 81 xx is the long form some encoders emit anyway.
  if [[ "${der:2:2}" == 81 ]]; then offset=6; else offset=4; fi
  for _ in r s; do
    [[ "${der:offset:2}" == 02 ]] || return 1
    length=$((16#${der:offset+2:2}))
    value="${der:offset+4:length*2}"
    (( ${#value} == length * 2 )) || return 1
    offset=$((offset + 4 + length * 2))
    while [[ "${value:0:2}" == 00 ]]; do value="${value:2}"; done
    (( ${#value} <= 64 )) || return 1
    while (( ${#value} < 64 )); do value="0$value"; done
    raw+="$value"
  done
  printf '%s\n' "$raw"
}

# Builds the ES256 JWT App Store Connect accepts from a team API key: no
# library needed, only openssl. Lives 19 minutes, inside Apple's 20-minute cap.
#
# Args: key_id issuer_id p8_path now_epoch. Echoes the token.
asc_jwt() {
  local key_id="$1" issuer_id="$2" p8_path="$3" now_epoch="$4"
  local header payload signing_input der_hex raw_hex
  header="$(printf '{"alg":"ES256","kid":"%s","typ":"JWT"}' "$key_id" | base64url)"
  payload="$(printf '{"iss":"%s","iat":%d,"exp":%d,"aud":"appstoreconnect-v1"}' \
    "$issuer_id" "$now_epoch" "$((now_epoch + 1140))" | base64url)"
  signing_input="$header.$payload"
  der_hex="$(printf '%s' "$signing_input" | openssl dgst -sha256 -sign "$p8_path" \
    | od -An -v -tx1 | tr -d ' \n')" || return 1
  raw_hex="$(der_signature_to_raw "$der_hex")" || return 1
  printf '%s.%s\n' "$signing_input" \
    "$(printf '%b' "$(sed 's/../\\x&/g' <<< "$raw_hex")" | base64url)"
}

# SHA-256 of a public key's SubjectPublicKeyInfo, which is what pairs a
# certificate with the private key it was issued for.
# Args: `key` and a PEM private key, or `certificate` and a DER certificate.
public_key_digest() {
  local kind="$1" path="$2"
  case "$kind" in
    key) openssl pkey -in "$path" -pubout -outform DER ;;
    certificate) openssl x509 -inform DER -in "$path" -noout -pubkey | openssl pkey -pubin -outform DER ;;
    *) return 1 ;;
  esac | openssl dgst -sha256 | sed 's/^.*= *//'
}

# Every piece of App Store Connect JSON this script reads or writes goes
# through here, so none of it is parsed with sed. Args: a subcommand and its
# arguments:
#
#   certificates <response> <types>     id, type, expiry epoch, expiry date,
#                                       name and base64 DER per certificate of the
#                                       comma-separated types, longest-lived
#                                       first, tab-separated
#   app-id <response> <identifier> <platforms>
#                                       `found <id>`, `missing`, or
#                                       `wrong-platform <platforms>`
#   profiles <response> <name>          id, state, expiry epoch, expiry date,
#                                       certificate ids and App ID id of each
#                                       profile with exactly that name
#   profile-content <response> <id>     a listed profile's base64 content
#   data <response> <attribute|id>      a field of a single-resource response
#   errors <response>                   one line per error Apple returned
#   certificate-request <type> <csr>    the body of POST /v1/certificates
#   profile-request <name> <type> <app id id> <certificate id>
#                                       the body of POST /v1/profiles
#   identifier <tauri.conf.json>        the app's bundle identifier
#   query <text>                        the text, URL-encoded
#
# python3 3.9 is what the Xcode command line tools ship, so nothing newer.
asc_json() {
  python3 - "$@" <<'PY'
import json, sys, urllib.parse
from datetime import datetime

command, args = sys.argv[1], sys.argv[2:]


def load(path):
    with open(path) as handle:
        return json.load(handle)


def epoch(stamp):
    # Apple writes "2027-10-09T17:34:11.000+00:00"; 3.9's fromisoformat
    # rejects a trailing Z, which some responses use instead.
    moment = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    return int(moment.timestamp()), moment.strftime('%Y-%m-%d')


def related_ids(resource, name):
    data = ((resource.get('relationships') or {}).get(name) or {}).get('data')
    if data is None:
        return []
    if isinstance(data, dict):
        return [data['id']]
    return [item['id'] for item in data]


if command == 'certificates':
    wanted = set(args[1].split(','))
    rows = []
    for cert in load(args[0]).get('data', []):
        attributes = cert['attributes']
        if attributes.get('certificateType') not in wanted:
            continue
        expires, date = epoch(attributes['expirationDate'])
        rows.append((expires, cert['id'], attributes['certificateType'], date,
                     attributes.get('name') or attributes.get('displayName') or '',
                     attributes.get('certificateContent', '')))
    for expires, cert_id, kind, date, name, content in sorted(rows, reverse=True):
        print('\t'.join([cert_id, kind, str(expires), date, name, content]))

elif command == 'app-id':
    # filter[identifier] is a substring match, so `io.example.app` also
    # returns `io.example.app.widget`; only an exact identifier counts.
    identifier, platforms = args[1], set(args[2].split(','))
    exact = [record for record in load(args[0]).get('data', [])
             if record['attributes'].get('identifier') == identifier]
    usable = [record for record in exact
              if record['attributes'].get('platform') in platforms]
    if usable:
        print('found', usable[0]['id'])
    elif exact:
        print('wrong-platform', ','.join(sorted(
            record['attributes'].get('platform') or 'unknown' for record in exact)))
    else:
        print('missing')

elif command == 'profiles':
    for profile in load(args[0]).get('data', []):
        attributes = profile['attributes']
        if attributes.get('name') != args[1]:
            continue
        expires, date = epoch(attributes['expirationDate'])
        print('\t'.join([profile['id'], attributes.get('profileState') or '',
                         str(expires), date,
                         ','.join(related_ids(profile, 'certificates')),
                         ','.join(related_ids(profile, 'bundleId'))]))

elif command == 'profile-content':
    for profile in load(args[0]).get('data', []):
        if profile['id'] == args[1]:
            print(profile['attributes']['profileContent'])

elif command == 'data':
    data = load(args[0])['data']
    print(data['id'] if args[1] == 'id' else data['attributes'][args[1]])

elif command == 'errors':
    try:
        errors = load(args[0]).get('errors', [])
    except (OSError, ValueError):
        errors = []
    for error in errors:
        print('{} {}: {} — {}'.format(error.get('status', '?'), error.get('code', '?'),
                                      error.get('title', ''), error.get('detail', '')))

elif command == 'certificate-request':
    with open(args[1]) as handle:
        csr = handle.read()
    print(json.dumps({'data': {'type': 'certificates', 'attributes': {
        'certificateType': args[0], 'csrContent': csr}}}))

elif command == 'profile-request':
    name, profile_type, app_id, cert_id = args
    print(json.dumps({'data': {
        'type': 'profiles',
        'attributes': {'name': name, 'profileType': profile_type},
        'relationships': {
            'bundleId': {'data': {'type': 'bundleIds', 'id': app_id}},
            'certificates': {'data': [{'type': 'certificates', 'id': cert_id}]},
        }}}))

elif command == 'identifier':
    print(load(args[0])['identifier'])

elif command == 'query':
    print(urllib.parse.quote(args[0], safe=''))

else:
    sys.exit('asc_json: unknown subcommand ' + command)
PY
}
