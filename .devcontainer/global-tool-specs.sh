#!/usr/bin/env bash
# Prints the `pnpm install -g` specs for the bootstrap toolchain, each at the
# exact version pnpm-lock.yaml resolves for its catalog entry:
#
#   vite-plus@<version> typescript@<version> @tsdown/css@<version>
#
# A global install cannot reference the workspace catalog, and an unpinned
# global `vite-plus` drifts ahead of the workspace (its bundled vitest then
# peer-warns against the aliased vite). Reading the lockfile keeps the global
# toolchain on the workspace's versions with nothing to edit on a bump.
#
# Usage: global-tool-specs.sh [path/to/pnpm-lock.yaml]
#
# Runs before anything is installed, so it uses awk rather than a YAML parser.
set -euo pipefail

lockfile="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pnpm-lock.yaml}"

if [ ! -f "$lockfile" ]; then
  echo "global-tool-specs: no lockfile at $lockfile" >&2
  exit 1
fi

# The resolved version of one entry in the lockfile's `catalogs.default` map:
#
#   catalogs:
#     default:
#       vite-plus:
#         specifier: 1.6.0
#         version: 1.6.0
#
# The key is passed as the lockfile spells it, quotes included.
catalog_version() {
  local key="$1" version
  version="$(
    awk -v entry="    $key:" '
      $0 == "catalogs:" { in_catalogs = 1; next }
      in_catalogs && /^[^ ]/ { exit }
      in_catalogs && $0 == "  default:" { in_default = 1; next }
      in_default && /^  [^ ]/ { exit }
      in_default && $0 == entry { in_entry = 1; next }
      in_entry && /^    [^ ]/ { exit }
      in_entry && $1 == "version:" { print $2; exit }
    ' "$lockfile"
  )"
  if [ -z "$version" ]; then
    echo "global-tool-specs: no resolved version for catalog entry $key in $lockfile" >&2
    exit 1
  fi
  printf '%s' "$version"
}

# `typescript-7` is the catalog alias for the `typescript` 7 npm package.
vite_plus="$(catalog_version 'vite-plus')"
typescript="$(catalog_version 'typescript-7')"
tsdown_css="$(catalog_version "'@tsdown/css'")"

echo "vite-plus@$vite_plus typescript@$typescript @tsdown/css@$tsdown_css"
