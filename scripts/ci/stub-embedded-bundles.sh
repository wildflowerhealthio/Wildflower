#!/usr/bin/env bash
# Writes placeholders for the generated web bundles that Rust crates
# `include_str!`, so a Rust-only CI job compiles the workspace without a pnpm
# install or a `vp run pack`. They are gitignored build outputs, absent in a
# fresh checkout, and the crates that embed them don't compile without them.
#
#   sniffer  browser-sniffer-tauri-rust embeds the bootstrap IIFE generated
#            from browser-sniffer-tauri. Padded to clear its
#            `bootstrap_is_non_empty` test. Only the desktop bundle needs a
#            stand-in: `native-bootstrap.js` is behind a `cfg(ios|android)`
#            gate, compiled out on desktop targets.
#
# The paths live here rather than inline in each workflow so ci-rust.yml and
# rust-cache-warm.yml can't drift.
#
# `all` stubs every bundle listed above; it is what the cache-warm job runs, so
# a bundle added later is covered there without editing the workflow.
#
# Usage: stub-embedded-bundles.sh <sniffer|all>
set -euo pipefail

target="${1:?usage: stub-embedded-bundles.sh <sniffer|all>}"

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

case "$target" in
  sniffer | all) stub_sniffer ;;
  *)
    echo "stub-embedded-bundles: unknown target '$target' (expected sniffer|all)" >&2
    exit 1
    ;;
esac
