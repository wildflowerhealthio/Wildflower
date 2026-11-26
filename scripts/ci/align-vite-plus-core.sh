#!/usr/bin/env bash
# Moves the catalog `vite` alias in pnpm-workspace.yaml to the core that the
# catalog's `vite-plus` depends on, for dependabot-vite-plus.yml:
#
#   align-vite-plus-core.sh
#
# Dependabot bumps the catalog `vite-plus:` entry but never the
# `vite: npm:@voidzero-dev/vite-plus-core@<version>` alias, because it does not
# update `npm:` aliases. The two must agree (docs/Dependencies/Bumping vite-plus
# How-To.md), so a bump on its own fails every `vp` run. The core to align to
# is the `vite` dependency in that vite-plus release's own package.json. When
# the alias already names it, the script changes nothing. Otherwise it runs
# that release's migrator, which moves the alias, rewrites any config the
# release changed, and reinstalls.
#
# Run from the repository root. Writes `changed=true|false` to
# `$GITHUB_OUTPUT` when it is set.
set -euo pipefail

workspace=pnpm-workspace.yaml

# The catalog's two-space-indented entries, without quotes.
catalog_value() {
  sed -n "s/^  $1: *//p" "$workspace" | tr -d "'\""
}

vite_plus=$(catalog_value vite-plus)
current=$(catalog_value vite)
if [[ -z $vite_plus || -z $current ]]; then
  echo "error: no catalog vite-plus or vite entry in $workspace" >&2
  exit 1
fi

wanted=$(npm view "vite-plus@$vite_plus" dependencies.vite)

report() {
  if [[ -n ${GITHUB_OUTPUT:-} ]]; then
    echo "changed=$1" >> "$GITHUB_OUTPUT"
  fi
}

if [[ $current == "$wanted" ]]; then
  echo "vite-plus $vite_plus: the vite alias already names $wanted"
  report false
  exit 0
fi

echo "vite-plus $vite_plus depends on $wanted; the vite alias names $current. Migrating."
vp dlx -p "vite-plus@$vite_plus" vp migrate --no-interactive

after=$(catalog_value vite)
if [[ $after != "$wanted" ]]; then
  echo "error: after vp migrate the vite alias names $after, not $wanted" >&2
  exit 1
fi
report true
