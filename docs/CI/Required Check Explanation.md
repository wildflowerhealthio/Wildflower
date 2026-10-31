# Required Check Explanation

Why every pull request's checks funnel into one `Required` status check, and
how `.github/workflows/ci.yml` decides what runs. To add a new area of checks,
see the [Adding a Check Area How-To](./Adding%20a%20Check%20Area%20How-To.md).

## What `Required` guarantees

The `main` ruleset requires one status check, `Required`, which `ci.yml` reports
on every pull request. It passes only when every CI job that applies to the pull
request has passed. With an approving review, that is enough to merge. Turning
on auto-merge merges a pull request as soon as both hold. Nothing lands on
`main` with a failing TypeScript, Rust, Pebble, Markdown, API Sync, Actions Lint, Shell Lint or Android check.

## Why one check and not one per job

The areas' checks are path-gated. A docs-only pull request shouldn't wait on a
workspace-wide Rust build, so each area runs only when the pull request touches
its inputs. GitHub can't require a check that may never start: a required check
whose workflow is filtered out stays "Expected — Waiting for status to be
reported" forever, and the pull request can never merge. Path filters in a
workflow's `on.pull_request.paths` therefore can't coexist with requiring that
workflow's checks.

`ci.yml` moves the filtering inside a workflow that always starts:

1. **`Detect changes`** runs `dorny/paths-filter` with one filter per area, the
   lists that used to be each workflow's trigger `paths`.
2. **One job per area** calls that area's workflow (`ci-typescript.yml`,
   `ci-rust.yml`, `ci-pebble.yml`, `lint-markdown.yml`, `api-sync.yml`, `lint-actions.yml`, `lint-shell.yml`, `ci-android.yml`) through
   `workflow_call`, gated on its filter. An untouched area's job is skipped.
3. **`Required`** needs all of them and runs with `if: always()`. It fails when
   any job failed or was cancelled and passes otherwise, so a skipped area counts
   as passing.

The ruleset names only `Required`, so adding, renaming or splitting jobs inside
an area never touches the ruleset. The per-job checks still show in the pull
request, prefixed with the area, such as `CI / Rust / Lint` or
`CI / TypeScript / Test (apps/strength)`. An area's job in `ci.yml` takes the
result of its whole workflow: one failed job inside it, including one leg of a
matrix such as the TypeScript test shards, fails the area and so `Required`.

`Rust Dependency Check` (`rust-deny` in `ci.yml`) is the one exception: it runs
on Rust pull requests but sits outside `Required`'s `needs`. A new RustSec
advisory or a yanked release lands on unchanged dependencies, so gating on it
would block every Rust pull request until someone triages it. It still reports a
failed check on the pull request, and `advisories-rust.yml` runs the advisory
half weekly.

## Why `always()` and not `!cancelled()`

GitHub treats a skipped required check as passing. If `Required` ran only on
uncancelled runs, cancelling a run on a pull request's head commit would skip
it, and the pull request would look green without having run its checks.
`always()` makes a cancelled run report a failing `Required` instead. The
superseded runs the concurrency group cancels report one too, but only on
commits that are no longer the head, which the ruleset doesn't look at.

## Draft pull requests

Draft pull requests run every check, the same as ready ones: a draft only
marks what isn't ready to read yet, and its author still wants the results.
Marking a draft ready for review doesn't re-run `ci.yml`; the checks on its
head commit already stand.

## Caches

A called workflow runs in the calling `pull_request` run, with that run's ref,
so it restores and saves caches exactly as it did when it was triggered
directly. The [TypeScript](../TypeScript/CI%20Build%20Cache%20Explanation.md),
[Rust](../Rust/CI%20Build%20Cache%20Explanation.md) and
[Pebble](../Pebble/CI%20Build%20Cache%20Explanation.md) CI Build Cache
Explanations cover each cache.
