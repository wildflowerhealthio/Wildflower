#!/usr/bin/env bash
# Single source of truth for the workspace's Rust lint/format/test invocations.
#
# Both the git hooks (.vite-hooks/* + the `staged` block in vite.config.ts) and
# the CI workflows (.github/workflows/ci-rust.yml, ci-rust-tauri.yml) call this,
# so the `--exclude`/`-p` crate lists and the nextest flags live in exactly one
# place and can't drift between local checks and CI.
#
# The hook entrypoints degrade gracefully so they never block a contributor who
# legitimately can't run a step locally — CI still gates all of it on PRs:
#   - no `cargo` on PATH (e.g. a frontend-only contributor)  -> skip
#   - no `cargo-nextest`                                      -> fall back to `cargo test`
#   - a Tauri step on a machine without the GTK/webkit libs   -> skip
# In CI none of these escape hatches trigger (the toolchain, nextest, and — on
# the Tauri runner — the GTK libs are all installed), so CI runs every step for
# real.
#
# Subcommands:
#   fmt | clippy | test            non-Tauri workspace (ci-rust.yml)
#   tauri-clippy | tauri-test      the GTK/webkit Tauri crates (ci-rust-tauri.yml)
#   pre-commit                     fmt + clippy + tauri-clippy   (lint/format)
#   pre-push                       test + tauri-test             (tests)
set -euo pipefail

step="${1:?usage: rust.sh <fmt|clippy|test|tauri-clippy|tauri-test|pre-commit|pre-push>}"

have() { command -v "$1" >/dev/null 2>&1; }

if ! have cargo; then
  echo "checks/rust: cargo not found — skipping '$step' (CI still gates Rust on PRs)."
  exit 0
fi

# The crates ci-rust.yml builds (everything except the GTK/webkit-dependent Tauri
# crates) vs. the Tauri crates that ci-rust-tauri.yml owns.
non_tauri=(--workspace
  --exclude wildflower-tauri
  --exclude browser-sniffer-tauri-rust
  --exclude shared-structures-tauri-rust)
tauri=(-p wildflower-tauri -p browser-sniffer-tauri-rust -p shared-structures-tauri-rust)

run_tests() { # usage: run_tests <pkg-selection...>
  if have cargo-nextest; then
    # --no-tests=warn matches CI: stay green while these crates have ~no tests.
    cargo nextest run "$@" --all-features --no-tests=warn
  else
    echo "checks/rust: cargo-nextest not found — falling back to 'cargo test'."
    cargo test "$@" --all-features
  fi
}

tauri_capable() {
  if have pkg-config && pkg-config --exists webkit2gtk-4.1; then
    return 0
  fi
  echo "checks/rust: GTK/webkit libs not found — skipping Tauri step (CI still gates this on PRs)."
  return 1
}

do_fmt() { cargo fmt --all --check; }
do_clippy() { cargo clippy "${non_tauri[@]}" --all-targets --all-features -- -D warnings; }
do_test() { run_tests "${non_tauri[@]}"; }
do_tauri_clippy() {
  tauri_capable || return 0
  cargo clippy "${tauri[@]}" --all-targets --all-features -- -D warnings
}
do_tauri_test() {
  tauri_capable || return 0
  run_tests "${tauri[@]}"
}

case "$step" in
  fmt) do_fmt ;;
  clippy) do_clippy ;;
  test) do_test ;;
  tauri-clippy) do_tauri_clippy ;;
  tauri-test) do_tauri_test ;;
  pre-commit)
    do_fmt
    do_clippy
    do_tauri_clippy
    ;;
  pre-push)
    do_test
    do_tauri_test
    ;;
  *)
    echo "checks/rust: unknown step '$step'" >&2
    exit 2
    ;;
esac
