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
