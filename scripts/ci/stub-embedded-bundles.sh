#!/usr/bin/env bash
# Writes placeholders for the generated web bundles that Rust crates
# `include_str!` or `include_dir!`, so a Rust-only CI job compiles the
# workspace without a pnpm install or a `vp run pack`. They are gitignored
# build outputs, absent in a fresh checkout, and the crates that embed them
# don't compile without them.
#
#   sniffer  browser-sniffer-tauri-rust embeds the bootstrap IIFE generated
#            from browser-sniffer-tauri. Padded to clear its
#            `bootstrap_is_non_empty` test. Only the desktop bundle needs a
#            stand-in: `native-bootstrap.js` is behind a `cfg(ios|android)`
#            gate, compiled out on desktop targets.
#   relay-admin-web
#            wildflower-relay embeds the admin UI's build
#            (apps/relay/admin-web, `vp build`) with `include_dir!`. A bare
#            index.html stands in; the relay's own tests serve a build they
#            define themselves.
#
# The paths live here rather than inline in each workflow so ci-rust.yml and
# rust-cache-warm.yml can't drift.
#
# `all` stubs every bundle listed above; it is what the cache-warm job runs, so
# a bundle added later is covered there without editing the workflow.
#
# Usage: stub-embedded-bundles.sh <sniffer|relay-admin-web|all>
set -euo pipefail

target="${1:?usage: stub-embedded-bundles.sh <sniffer|relay-admin-web|all>}"

stub_sniffer() {
  local out=slices/browser-sniffer/browser-sniffer-tauri/dist/tauri-bootstrap.js
  mkdir -p "$(dirname "$out")"
  {
    echo '// CI stub: the real IIFE is generated from browser-sniffer-tauri by'
    echo '// its `generate-tauri-bootstrap` script. Padded to stay long enough'
    echo '// to satisfy bootstrap_is_non_empty.'
    for _ in $(seq 1 40); do
      echo '// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    done
  } > "$out"
  echo "stub-embedded-bundles: wrote $out"
}

stub_relay_admin_web() {
  local out=apps/relay/admin-web/dist/index.html
  mkdir -p "$(dirname "$out")"
  {
    echo '<!doctype html>'
    echo '<!-- CI stub: the real page is the build of apps/relay/admin-web. -->'
    echo '<title>Relay admin</title>'
  } > "$out"
  echo "stub-embedded-bundles: wrote $out"
}

case "$target" in
  sniffer) stub_sniffer ;;
  relay-admin-web) stub_relay_admin_web ;;
  all)
    stub_sniffer
    stub_relay_admin_web
    ;;
  *)
    echo "stub-embedded-bundles: unknown target '$target' (expected sniffer|relay-admin-web|all)" >&2
    exit 1
    ;;
esac
