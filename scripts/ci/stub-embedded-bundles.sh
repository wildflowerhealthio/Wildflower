#!/usr/bin/env bash
# Writes placeholders for the generated web bundles that Rust crates
# `include_str!` or `include_dir!`, so a Rust-only CI job compiles the
# workspace without a pnpm install or a `vp run pack`. They are gitignored
# build outputs, absent in a fresh checkout, and the crates that embed them
# don't compile without them.
#
#   sniffer  browser-sniffer-tauri embeds the bootstrap IIFEs generated
#            from browser-sniffer-tauri-js: `tauri-bootstrap.js` on desktop
#            targets, padded to clear its `bootstrap_is_non_empty` test, and
#            `native-bootstrap.js` on iOS and Android, which ci-android.yml's
#            `check` job compiles for.
#   relay-admin-web
#            wildflowerhealthio-relay-server embeds the admin UI's build
#            (apps/relay/relay-admin-web, `vp build`) with `include_dir!`. A bare
#            index.html stands in; the relay's own tests serve a build they
#            define themselves.
#   authorization-server-web
#            wildflowerhealthio-authorization-server embeds the authorization
#            pages' build (apps/host/wildflower-server/authorization-server-web,
#            `vp build`) with `include_dir!`. A bare consent.html,
#            limited.html, device.html and pair.html stand in; the crate's
#            own tests serve a build they define themselves.
#
# The paths live here rather than inline in each workflow so ci-rust.yml and
# rust-cache-warm.yml can't drift.
#
# `all` stubs every bundle listed above; it is what the cache-warm job runs, so
# a bundle added later is covered there without editing the workflow.
#
# Usage: stub-embedded-bundles.sh <sniffer|relay-admin-web|authorization-server-web|all>
set -euo pipefail

target="${1:?usage: stub-embedded-bundles.sh <sniffer|relay-admin-web|authorization-server-web|all>}"

stub_sniffer() {
  local dist=slices/browser-sniffer/browser-sniffer-tauri-js/dist
  local bootstrap out
  mkdir -p "$dist"
  for bootstrap in tauri native; do
    out="$dist/$bootstrap-bootstrap.js"
    {
      echo '// CI stub: the real IIFE is generated from browser-sniffer-tauri-js by'
      echo "// its \`generate-$bootstrap-bootstrap\` script. Padded to stay long enough"
      echo '// to satisfy bootstrap_is_non_empty.'
      for _ in $(seq 1 40); do
        echo '// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
      done
    } > "$out"
    echo "stub-embedded-bundles: wrote $out"
  done
}

stub_relay_admin_web() {
  local out=apps/relay/relay-admin-web/dist/index.html
  mkdir -p "$(dirname "$out")"
  {
    echo '<!doctype html>'
    echo '<!-- CI stub: the real page is the build of apps/relay/relay-admin-web. -->'
    echo '<title>Relay admin</title>'
  } > "$out"
  echo "stub-embedded-bundles: wrote $out"
}

stub_authorization_server_web() {
  local dist=apps/host/wildflower-server/authorization-server-web/dist
  mkdir -p "$dist"
  local page title out
  for page in 'consent:Approve access' 'limited:Limited access' 'device:Authorize a device' 'pair:Sign in this browser'; do
    title="${page#*:}"
    out="$dist/${page%%:*}.html"
    {
      echo '<!doctype html>'
      echo '<!-- CI stub: the real page is the build of apps/host/wildflower-server/authorization-server-web. -->'
      echo "<title>$title</title>"
    } > "$out"
    echo "stub-embedded-bundles: wrote $out"
  done
}

case "$target" in
  sniffer) stub_sniffer ;;
  relay-admin-web) stub_relay_admin_web ;;
  authorization-server-web) stub_authorization_server_web ;;
  all)
    stub_sniffer
    stub_relay_admin_web
    stub_authorization_server_web
    ;;
  *)
    echo "stub-embedded-bundles: unknown target '$target' (expected sniffer|relay-admin-web|authorization-server-web|all)" >&2
    exit 1
    ;;
esac
