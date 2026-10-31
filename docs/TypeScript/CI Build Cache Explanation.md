# CI Build Cache Explanation

Why `ci-typescript.yml` caches the `vp run pack` outputs, why the default branch
has to write that cache, and why both workflows go through one composite action.
The Rust counterpart is the
[Rust CI Build Cache Explanation](../Rust/CI%20Build%20Cache%20Explanation.md).

## What gets cached

The TypeScript jobs carry two independent caches:

- **The pnpm store** — `voidzero-dev/setup-vp` with `cache: true`. Every
  workflow that installs dependencies sets it, so any of them running on `main`
  saves the store into main's scope. In `ci-typescript.yml` only the `check`
  job saves it; the others set `cache-save: false` (see
  [One saver per run](#one-saver-per-run)).
- **The `vp run pack` outputs** — `.github/actions/vp-pack-cache`, a composite
  action wrapping `actions/cache`. It holds `node_modules/.vite/task-cache` (vp's
  task fingerprints and replayed output) together with every workspace `dist/`.
  Typecheck resolves cross-package imports against `dist/`, so a task-cache hit
  is only useful alongside the `dist/` it claims to have built; caching them as
  one entry keeps the two in step.

The pack cache key is:

```text
vp-pack-<runner os>-<commit sha>
```

with the restore prefix `vp-pack-<runner os>-`. Entries are write-once, so the
SHA gives every run its own entry, and the prefix restore picks the newest entry
the current ref can see. Build inputs are deliberately left out of the key: vp's
task cache fingerprints them itself and rebuilds only the packages whose inputs
moved, so restoring an older entry is still a partial hit rather than a miss.

## One saver per run

`ci-typescript.yml` packs the same commit in many jobs at once: `check` and
every test shard each restore the newest entry and run `vp run pack`. They all
compute the same `vp-pack-<os>-<sha>` key, and a key can be written only once,
so if each tried to save, one would win and the rest would each log a failed
save. Only `check` saves. The test shards call the composite action with
`save: 'false'`, which swaps `actions/cache` for `actions/cache/restore`: the
same paths and keys, no post-job save. The pnpm store follows the same rule
through `setup-vp`'s `cache-save` input.

A shard starts alongside `check`, not after it, so it never restores `check`'s
entry from the same run. It restores main's (or the pull request's previous
push's) and packs only what this push changed.

The Pages deploys restore the same entry without saving it: each job of
`pr-preview.yml`'s `deploy` and of `deploy-pages-site.yml`. Their site builds
(`scripts/ci/deploy-pages-sites.sh`) run `vp run --cache`, so a workspace
package the entry already holds, or an earlier site in the job built, is
replayed rather than rebuilt. An app's own `vp build` reports the environment
it reads to the task cache, and each build carries its commit as its Sentry
release, so app builds themselves miss.

## Why the default branch has to warm the cache

GitHub scopes Actions caches per ref. A run on a pull request can **restore** a
cache saved on its base branch, but never one saved by another pull request, and
its own saves land in that pull request's scope.

`ci-typescript.yml` is a pre-merge gate that runs on `pull_request` only, so
nothing writes a pack entry to `main`'s scope and every new pull request's first
run packs the whole workspace cold. `ts-cache-warm.yml` closes that: it installs
and runs `vp run pack` on every push to `main` and saves through the same
composite action. It restores main's previous entry first, so a warm run
rebuilds only what the push changed.

Unlike `rust-cache-warm.yml`, it has no path filter. A pull request restores the
newest main entry; a filter would leave that entry stale by whatever it misses,
and a push that touches no build input costs only an install and a task-cache
replay.

## Why one composite action

`actions/cache` versions every entry by its exact `path` list (plus compression
method), and a restore only matches entries of the same version. Two workflows
that spell the paths even slightly differently never see each other's entries,
whatever their keys say. The composite action holds the paths and key in one
place, so the warm job and CI cannot drift apart. Inside the action the path
list is written once and read by both its saving and its restore-only step, for
the same reason. `ci.yml`'s `typescript` filter
lists the action so a change to it runs CI.

## Eviction

GitHub evicts any entry untouched for 7 days, and evicts least-recently-used
entries once the repository passes its 10 GB cache budget. Every pull request
reads main's newest entry, which keeps it the most-recently-used. When it does
go, a `workflow_dispatch` on TypeScript Cache Warm rebuilds it.

## See Also

- [Rust CI Build Cache Explanation](../Rust/CI%20Build%20Cache%20Explanation.md)
  — the cargo cache keys and the equivalent Rust warm job
- [AGENTS.md](../../AGENTS.md) — the CI gate list this scheme belongs to
