# Bumping vite-plus How-To

The vite-plus version is recorded in two catalog values that must move **together**. A Dependabot bump moves only `vite-plus` and leaves the `vite` alias behind, which reintroduces the peer-tuple split that the alias exists to prevent (`Failed to resolve pack command: … Expected @voidzero-dev/vite-plus-core@<version>` from every `vp run`; on older releases `Cannot read properties of undefined (reading 'config')` in `vp test` and `TS2321: Excessive stack depth … 'UserConfig'` in every vite config). This doc is the checklist of every place to edit.

For _why_ the versions must agree — the pnpm variant-split mechanism, the `vite@*` override, and how to diagnose a split — see the [Version Override Explanation](./Version%20Override%20Explanation.md). This doc is only the "where to edit" list.

## The version is recorded in two coupled values

A vite-plus bump moves two distinct version strings:

- **`vite-plus`** itself — the package that ships the `vp` binary (currently `1.6.0`).
- **`@voidzero-dev/vite-plus-core`** — the `vite` alias vite-plus depends on. Must match the core that _this_ `vite-plus` depends on, **not** the newest core on npm (see the Explanation's "What a vite-plus bump needs from the overrides" section).

`vitest` is not pinned anywhere: vite-plus depends on an exact `vitest` (`5.1.0` on 1.6.0), and `vp --version` reports it.

## Every place to edit

| #   | File                                             | Key                  | Current value                            | Holds     |
| --- | ------------------------------------------------ | -------------------- | ---------------------------------------- | --------- |
| 1   | [pnpm-workspace.yaml](../../pnpm-workspace.yaml) | catalog `vite-plus:` | `1.6.0`                                  | vite-plus |
| 2   | [pnpm-workspace.yaml](../../pnpm-workspace.yaml) | catalog `vite:`      | `npm:@voidzero-dev/vite-plus-core@1.6.0` | core      |

The `vite@*: 'catalog:'` override in [pnpm-workspace.yaml](../../pnpm-workspace.yaml) follows row 2, so it needs no edit.

The bootstrap scripts that install a global `vp` ([.claude/hooks/session-start.sh](../../.claude/hooks/session-start.sh), [.devcontainer/postCreateCommand.sh](../../.devcontainer/postCreateCommand.sh), [.devcontainer/cloud-setup-script.sh](../../.devcontainer/cloud-setup-script.sh)) hold no version. A global `pnpm install -g` cannot reference the catalog, so each runs [.devcontainer/install-global-tools.sh](../../.devcontainer/install-global-tools.sh), which reads the version `pnpm-lock.yaml` resolves for each catalog entry and installs the globals at those versions. It skips the install only when the global `vp --version` already reports the lockfile's vite-plus, so a cached container picks up a bump on its next session.

## On a Dependabot PR

[dependabot-vite-plus.yml](../../.github/workflows/dependabot-vite-plus.yml) does step 1 for you. When Dependabot pushes a PR that changes [pnpm-workspace.yaml](../../pnpm-workspace.yaml), the workflow runs [scripts/ci/align-vite-plus-core.sh](../../scripts/ci/align-vite-plus-core.sh). The script looks up the core that the catalog's `vite-plus` release declares as its own `vite` dependency. If row 2 names a different core, it runs that release's migrator and pushes the result to the PR branch as one commit, and CI then runs again on it. Steps 2–3 are still yours. Oxlint and Oxfmt findings that a release brings need a hand fix, in their own commits on the same branch.

The push uses a GitHub App token, because a push made with `GITHUB_TOKEN` does not start CI again. The App needs **Contents: read and write** on this repository. Its client ID and private key are stored as the **Dependabot** secrets `DEPS_FIXUP_APP_CLIENT_ID` and `DEPS_FIXUP_APP_PRIVATE_KEY` (Settings → Secrets and variables → Dependabot), because a Dependabot-triggered run gets no Actions secrets.

To run the same alignment on any branch, run `scripts/ci/align-vite-plus-core.sh` from the repository root.

## Steps

1. For a minor or major release, run the **new** release's migrator first, against the old lockfile, so it can read the old versions and rewrite config the release changed:

   ```bash
   vp dlx -p vite-plus@<new> vp migrate --no-interactive
   ```

   It updates rows 1–2 and installs. Read its `REVIEW`/`BLOCK` output and the release notes. For a patch release, edit rows 1–2 by hand instead.

2. Run `vp install`, then verify there is exactly one core and one `vitest`:

   ```bash
   grep -oE "@voidzero-dev/vite-plus-core@[0-9.]+" pnpm-lock.yaml | sort -u   # expect one line
   grep -oE "^  vitest@[0-9][^(:]*" pnpm-lock.yaml | sort -u                  # expect one line
   ```

3. Build before you lint (an unbuilt workspace floods `vp lint` with `TS2307` that buries the real split errors), then run the suite. New bundled Oxlint/Oxfmt releases can flag or format code that passed before; run `vp fmt` and commit its output separately.

   ```bash
   vp run pack && vp check && vp test
   ```

## Related, but versioned independently

- **`voidzero-dev/setup-vp@vX.Y.Z`** in the [CI workflows](../../.github/workflows/) installs `vp` on the runners. It tracks its own release line (Dependabot bumps it separately) and is not the vite-plus version — it only needs to be new enough to run the pinned vite-plus. No manual sync with the rows above.
- **`typescript` 7 and `@tsdown/css`** are installed globally beside vite-plus by the same bootstrap scripts but are separate tools with their own catalog entries (`typescript-7`, `@tsdown/css` in [pnpm-workspace.yaml](../../pnpm-workspace.yaml)). The catalog may carry a range; [install-global-tools.sh](../../.devcontainer/install-global-tools.sh) installs the exact version `pnpm-lock.yaml` resolves. Its skip check looks only at vite-plus, so a container that already has the current global `vp` keeps its global `typescript` and `@tsdown/css` until the next vite-plus bump.

## See Also

- [Version Override Explanation](./Version%20Override%20Explanation.md) — why the `vite@*` override exists, why `vitest` is unpinned, and how to diagnose a variant split
- [pnpm-workspace.yaml](../../pnpm-workspace.yaml) — catalog definitions and the `overrides:` block
