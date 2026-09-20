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

# Builds a `plutil -extract` keypath from literal key names.
#
# plutil treats `.` as the keypath separator, so a key that itself contains
# dots has to have them escaped or plutil walks a nesting that does not exist
# and returns nothing. macOS entitlement keys are reverse-DNS namespaced
# (`com.apple.application-identifier`), so every one of them needs this; the
# iOS spelling (`application-identifier`) has no dots and is unaffected, which
# is why passing keys through unescaped only ever failed on the macOS side.
#
# Args: one or more literal key names, outermost first. Echoes the keypath.
plist_keypath() {
  local keypath="" key
  for key in "$@"; do
    keypath+="${keypath:+.}${key//./\\.}"
  done
  printf '%s\n' "$keypath"
}

# The application-identifier entitlement that carries "<team id>.<bundle id>"
# is spelled differently per platform: macOS namespaces it as
# `com.apple.application-identifier`, iOS uses the bare
# `application-identifier`. A profile carries one or the other, never both, so
# both preflights try both spellings rather than each knowing only its own.
#
# Echoes the keypaths to try, most specific first, one per line.
app_identifier_keypaths() {
  plist_keypath Entitlements com.apple.application-identifier
  plist_keypath Entitlements application-identifier
}

# Reads the "<team id>.<bundle id>" application-identifier out of a decoded
# profile by trying each platform's spelling in turn.
#
# The plist reader is injected rather than called directly so this, the part
# with the branching, is exercised by the Linux test suite; the preflights
# pass their plutil-backed `plist_value`. Args: the reader command name, which
# is called with one keypath and echoes the value there (empty when absent).
#
# Echoes the identifier and returns 0, or echoes nothing and returns 1 when no
# spelling matched.
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

# Decides whether an app record for $1 exists, given the bundle ids $2 that
# were read back from App Store Connect (newline-separated, possibly empty).
#
# Three-valued on purpose. `altool --list-apps` is the only cheap way to ask
# this question, and an empty or unparseable answer means "the question could
# not be asked" — a network blip, an output shape this does not know — not
# "the app does not exist". Reporting that as `absent` would block a release
# over a check that itself failed, so it is `unknown` and the caller warns
# instead of failing.
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
