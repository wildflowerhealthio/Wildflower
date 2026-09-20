#!/usr/bin/env bash
# Shared classification helpers for the Apple signing preflights. Sourced by
# apple-ios-signing-preflight.sh and apple-macos-appstore-preflight.sh, which
# each check a different distribution channel but have to tell the same
# certificate and profile kinds apart.
#
# Pure functions only: no I/O, no `security` calls, nothing macOS-specific —
# which is what lets scripts/checks/apple-signing-lib.test.ts run them on
# Linux CI.

# Apple renamed its certificate kinds but still issues and accepts the old
# names, so every spelling of a kind maps to one answer. Echoes
# distribution | mac-installer | development | developer-id |
# developer-id-installer | other.
#
# `distribution` covers App Store submission for both platforms: "Apple
# Distribution" replaced the per-platform names but "3rd Party Mac Developer
# Application" is still what older Mac App Store certificates are called.
identity_kind() {
  case "$1" in
    "Apple Distribution: "*|"iPhone Distribution: "*|"3rd Party Mac Developer Application: "*)
      echo distribution ;;
    "3rd Party Mac Developer Installer: "*|"Mac Installer Distribution: "*)
      echo mac-installer ;;
    "Apple Development: "*|"iPhone Developer: "*|"Mac Developer: "*)
      echo development ;;
    "Developer ID Installer: "*)
      echo developer-id-installer ;;
    "Developer ID Application: "*)
      echo developer-id ;;
    *)
      echo other ;;
  esac
}

# A provisioning profile does not state its kind; it is inferred from three
# keys. Order matters: an enterprise profile also omits ProvisionedDevices, so
# it has to be ruled out before the App Store case or the two look identical.
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

# Builds a `plutil -extract` keypath, escaping the dots inside each key name
# so plutil reads it as one key rather than a nesting — see "Reading
# entitlements out of a profile" in docs/Rust/Apple Release Signing
# Explanation.md.
#
# Args: one key name per path component, outermost first. Echoes the keypath.
plist_keypath() {
  local keypath="" key
  for key in "$@"; do
    keypath+="${keypath:+.}${key//./\\.}"
  done
  printf '%s\n' "$keypath"
}

# The per-platform spellings of the application-identifier entitlement, most
# specific first, one keypath per line.
app_identifier_keypaths() {
  plist_keypath Entitlements com.apple.application-identifier
  plist_keypath Entitlements application-identifier
}

# Reads the "<team id>.<bundle id>" application-identifier out of a decoded
# profile, trying each spelling in turn.
#
# The reader is injected so this branching runs under the Linux test suite
# rather than only on macOS; the preflights pass their plutil-backed
# `plist_value`. Args: a command called with one keypath that echoes the value
# there, empty when absent.
#
# Echoes the identifier and returns 0, or returns 1 when no spelling matched.
read_app_identifier() {
  local reader="$1" keypath value
  while IFS= read -r keypath; do
    value="$("$reader" "$keypath")"
    if [[ -n "$value" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  done < <(app_identifier_keypaths)
  return 1
}

# Decides whether an app record for $1 exists, given the newline-separated
# bundle ids $2 read back from App Store Connect.
#
# An empty answer is `unknown`, not `absent`: it means the question could not
# be asked, and failing a release over that is the trap described in "An app
# record is not an App ID" in docs/Rust/Apple Release Signing Explanation.md.
#
# Echoes present | absent | unknown.
app_record_verdict() {
  local wanted="$1" found="$2" id
  [[ -n "${found//[[:space:]]/}" ]] || { echo unknown; return; }
  while IFS= read -r id; do
    [[ "$id" == "$wanted" ]] && { echo present; return; }
  done <<< "$found"
  echo absent
}
