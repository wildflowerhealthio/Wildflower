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
tauri_names=" wildflower-tauri browser-sniffer-tauri-rust shared-structures-tauri-rust "

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

# Lightweight "changed crates vs origin/main" scoping, used only by the hook
# composites (pre-commit / pre-push) — CI keeps the full --workspace runs above.
# rust-affected.mjs prints the affected crate names (changed + their dependents),
# `__WORKSPACE__` when it can't scope safely, or nothing when no Rust files
# changed. node is part of the repo's toolchain; if it's somehow missing we fall
# back to the full workspace rather than skip coverage.
affected_crates() {
  if ! have node; then
    echo '__WORKSPACE__'
    return 0
  fi
  node "$(dirname "$0")/rust-affected.ts" || echo '__WORKSPACE__'
}

# usage: run_changed <clippy|test> <non-tauri|tauri> <affected-output>
# Runs the step against only the affected crates in the requested partition,
# falling back to the full partition on `__WORKSPACE__` and skipping when no
# crate in that partition changed.
run_changed() {
  kind="$1" part="$2" affected="$3"

  if [ -z "$affected" ]; then
    echo "checks/rust: no Rust changes vs origin/main — skipping $part $kind."
    return 0
  fi

  if [ "$affected" = '__WORKSPACE__' ]; then
    case "$part:$kind" in
      non-tauri:clippy) do_clippy ;;
      non-tauri:test) do_test ;;
      tauri:clippy) do_tauri_clippy ;;
      tauri:test) do_tauri_test ;;
    esac
    return 0
  fi

  pflags=''
  for n in $affected; do
    case "$tauri_names" in
      *" $n "*) if [ "$part" = tauri ]; then pflags="$pflags -p $n"; fi ;;
      *) if [ "$part" = non-tauri ]; then pflags="$pflags -p $n"; fi ;;
    esac
  done

  if [ -z "$pflags" ]; then
    echo "checks/rust: no $part crates changed — skipping $part $kind."
    return 0
  fi

  if [ "$part" = tauri ]; then
    tauri_capable || return 0
  fi

  # shellcheck disable=SC2086  # intentional word-splitting of the -p flags
  case "$kind" in
    clippy) cargo clippy $pflags --all-targets --all-features -- -D warnings ;;
    test) run_tests $pflags ;;
  esac
}

case "$step" in
  fmt) do_fmt ;;
  clippy) do_clippy ;;
  test) do_test ;;
  tauri-clippy) do_tauri_clippy ;;
  tauri-test) do_tauri_test ;;
  pre-commit)
    # fmt is compile-free and fast, so keep it whole-workspace; scope the
    # compile-heavy clippy to the crates changed vs origin/main (+ dependents).
    do_fmt
    affected="$(affected_crates)"
    run_changed clippy non-tauri "$affected"
    run_changed clippy tauri "$affected"
    ;;
  pre-push)
    affected="$(affected_crates)"
    run_changed test non-tauri "$affected"
    run_changed test tauri "$affected"
    ;;
  *)
    echo "checks/rust: unknown step '$step'" >&2
    exit 2
    ;;
esac
