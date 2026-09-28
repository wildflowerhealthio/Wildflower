# CI Build Cache Explanation

Why `ci-pebble.yml` caches the Pebble SDK install, what the entry holds, and why
nothing warms it on the default branch. The TypeScript and Rust counterparts are
the [TypeScript CI Build Cache Explanation](../TypeScript/CI%20Build%20Cache%20Explanation.md)
and the [Rust CI Build Cache Explanation](../Rust/CI%20Build%20Cache%20Explanation.md).

## What gets cached

`pebble build` needs two things no runner image has: pebble-tool, a Python
package, and a Pebble SDK, which `pebble sdk install` downloads with its ARM
toolchain and sets up with a Python venv and an `npm install`. Together they are
about 1 GB on disk. `.github/actions/setup-pebble-sdk` installs both and caches
them as one entry:

- **`~/.pebble-tool`** — pebble-tool installed by `uv tool install`, the `pebble`
  launcher, and the Python uv installed it on (`UV_PYTHON_PREFERENCE=only-managed`).
- **`~/.local/share/pebble-sdk/SDKs`** — the installed SDK and the `current`
  link that makes it active.

The Python goes into the entry because the SDK's venv links to pebble-tool's
interpreter by absolute path: an interpreter from the runner image could move
under a restored venv when the image updates. The rest of pebble-tool's persist
directory, `~/.local/share/pebble-sdk`, holds the account login and settings, so
it stays out.

The key is:

```text
pebble-sdk-<runner os>-<runner arch>-sdk-<sdk>-tool-<pebble-tool>-python-<python>
```

Every input the install depends on is in the key and there is no restore prefix,
so an entry is always the complete install for its pins and never goes stale;
changing a pin misses and installs fresh. The action restores and saves the
entry itself (`actions/cache/restore` and `actions/cache/save`) straight after a
cold install, so a later failing step, such as `pebble build`, doesn't lose it.

The pins default in the action so every workflow that builds a `.pbw` builds it
with the same SDK. Each workflow sets the SDK up once, in one job that builds
both apps, so a run never has two jobs installing cold and racing to save the
same key. A cold install takes under a minute; the cache is as much about not
depending on the SDK's download server on every run as about time.

## Why the default branch doesn't warm it

GitHub scopes Actions caches per ref: a pull request's run restores entries its
base branch saved, and its own saves land in its own scope. `ci-pebble.yml` runs
on pull requests only, so each pull request's first run installs cold and its
later runs hit. Unlike the TypeScript and Rust caches, nothing warms `main`: a
cold install costs less than a warm job would on every push, and the entry has
no partial hit to restore. The same goes for `tauri-release-publish.yml`, whose
`build-pebble` job builds the release `.pbw`s through the same action: a release
runs rarely enough that it installs cold.

## See Also

- [TypeScript CI Build Cache Explanation](../TypeScript/CI%20Build%20Cache%20Explanation.md)
  — the `vp run pack` cache and why `main` warms it
- [apps/watch-lifts README](../../apps/watch-lifts/README.md#ci) — what the
  Pebble workflow checks and the `.pbw` artifacts it uploads
- [AGENTS.md](../../AGENTS.md) — the CI gate list this workflow belongs to
