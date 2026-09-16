# CI Build Cache Explanation

Why every GitHub Actions job that runs cargo names its build environment with a
`cache-shared-key`, which jobs share one cache entry, and why the rest can't.

## What the cache key is made of

Each cargo job sets up its toolchain with `actions-rust-lang/setup-rust-toolchain`,
which wraps `Swatinem/rust-cache`. That action caches `~/.cargo/registry`,
`~/.cargo/git`, `~/.cargo/bin` and the workspace `target/` under a key built from:

```text
v0-rust-<cache-shared-key>-<os type>-<os arch>-<env hash>-<lock hash>
```

- **env hash** — `rustc -vV` plus every `CARGO*`, `CC*`, `CFLAGS*`, `CXX*`,
  `CMAKE*` and `RUST*` environment variable. Differing `rustflags` fork the key
  on their own.
- **lock hash** — the root `Cargo.lock`, every workspace manifest, and
  `rust-toolchain.toml`.
- **restore key** — everything up to and including the env hash. A lockfile bump
  therefore still restores the previous entry and recompiles only what moved.

Two things the key does **not** capture, both of which the scheme has to handle
by hand:

- **The runner image version.** `ubuntu-latest` and `ubuntu-22.04` both record
  `Linux`, so two jobs on different Ubuntu images must not share a key or they
  mix artifacts linked against different glibc versions.
- **Which jobs are allowed to reuse each other's artifacts.** That is exactly
  what `cache-shared-key` decides: jobs sharing a value share an entry.

## The shared keys

| Key                   | Jobs                                                   | Environment                                                            |
| --------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `workspace-linux-dev` | `ci-rust.yml` → `rust`; `rust-cache-warm.yml` → `warm` | Full workspace, `ubuntu-latest`, dev profile, default rustflags        |
| `release-macos`       | `tauri-release-publish.yml` → `build` (macOS)          | Release profile, `x86_64`/`aarch64-apple-darwin` for the universal app |
| `release-windows`     | `tauri-release-publish.yml` → `build` (Windows)        | Release profile, rustflags add `-C link-arg=advapi32.lib`              |
| `release-linux`       | `tauri-release-publish.yml` → `build` (Linux)          | Release profile, `ubuntu-22.04` — a different image from CI's          |
| `release-ios`         | `tauri-release-publish.yml` → `build-ios`              | Release profile, `aarch64-apple-ios`                                   |
| `registry-linux`      | `tauri-release-prepare.yml` → `prepare`                | No compile at all; `cache-targets: false`, registry and git only       |

Every one of them pins `cache-on-failure: true` — also the action's own default,
stated outright because the scheme depends on it: a red run still saves the
dependency layer instead of making the next run recompile the world to reach the
same failure.

The release keys stay separate because their artifacts genuinely aren't
interchangeable — release profile rather than dev, per-platform rustflags, extra
target triples, and for Linux a different runner image. iOS keeps its own key
even though it shares `macos-latest` with the desktop macOS build: its
`aarch64-apple-ios` artifacts are disjoint from that job's `*-apple-darwin`
ones, and the two jobs run concurrently, so one key would make them race to save
mutually incomplete target directories.

`registry-linux` exists because `cargo set-version` rewrites manifests and
re-resolves the lockfile without compiling anything. It needs the registry
index, not a multi-GB `target/` download.

The `deny` job in `ci-rust.yml` and `advisories-rust.yml` configure no cache at
all: `cargo-deny-action` runs in its own container and compiles nothing.

## Why the default branch has to warm the cache

GitHub scopes Actions caches per ref. A run on a pull request can **restore** a
cache saved on its base branch, but never one saved by another pull request, and
its own saves land in that pull request's scope.

`ci-rust.yml` is a pre-merge gate that runs on `pull_request` only. Nothing else
writes to `main`'s scope, so without help every new pull request pays a cold
dependency compile. `rust-cache-warm.yml` closes that: it runs on `main`
whenever the dependency graph moves (`Cargo.lock`, any workspace manifest,
`rust-toolchain.toml`) and saves under `workspace-linux-dev`. Its `paths` list
the root `Cargo.toml` both bare and under `**/`: a `**/`-prefixed pattern is not
guaranteed to match a root-level file, and that manifest's `[workspace.lints]`
and `[workspace.dependencies]` feature lists fork the lock hash without
necessarily moving `Cargo.lock`. `ci-rust.yml` lists both spellings for the same
reason.

It reproduces `ci-rust.yml`'s environment exactly — same runner image, same
toolchain action with no extra `CARGO*`/`RUST*` env or rustflags, same
GTK/webkit libs, same stubbed bundles — because anything that differs there
would fork the env hash and leave the two jobs with separate entries anyway.
It compiles through `scripts/checks/rust.sh build-all`, the compile-only sibling
of `clippy-all` / `test-all`, which reuses `clippy-all`'s
`--workspace --all-targets --all-features` selection — a superset of the targets
`test-all` builds: feature unification and target selection are part of an
artifact's fingerprint, so a warm-up that differed on either would cache
artifacts CI then rebuilds.

Two things drop the warm entry: GitHub evicts any entry untouched for 7 days,
and it evicts least-recently-used entries once the repository passes its 10 GB
cache budget. Pull-request runs save under this key into their own scopes, which
is what consumes that budget — but they are the cold entries, because every pull
request _reads_ main's, so main's stays the most-recently-used and survives.
When it does go, a `workflow_dispatch` on Rust Cache Warm rebuilds it.

A dispatch cannot _replace_ an entry, though: cache keys are write-once, and
rust-cache skips saving on an exact-key hit. So the one case a re-warm can't fix
is a stale entry under a live key — `ubuntu-latest` moving to a new image, which
the key records only as `Linux`. If restored dependency artifacts ever fail to
link after such a bump, change the `cache-shared-key` value itself (a new key
means a new entry).

The release builds are deliberately not warmed. Three release-profile Tauri
builds per lockfile bump would cost far more than the handful of cold release
builds it would save. A `workflow_dispatch` publish run from `main` does save
into main's scope, so back-to-back dispatched rebuilds hit; a run triggered by
the merged release PR can only read.

## See Also

- [AGENTS.md](../../AGENTS.md) — the CI gate list this scheme belongs to
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — git hooks and the local checks that
  share `scripts/checks/rust.sh` with CI
