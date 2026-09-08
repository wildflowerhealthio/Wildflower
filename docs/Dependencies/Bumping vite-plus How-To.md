# Bumping vite-plus How-To

The vite-plus version is recorded in several places that must move **together**. A Dependabot bump touches only the workspace catalog and leaves the rest behind, which reintroduces the peer-tuple split that the pins exist to prevent (`Cannot read properties of undefined (reading 'config')` in `vp test`; `TS2321: Excessive stack depth … 'UserConfig'` in every vite config). This doc is the checklist of every place to edit.

For _why_ the exact pins exist — the pnpm variant-split mechanism, the `vite`/`vitest` overrides, and how to diagnose a split — see the [Version Override Explanation](./Version%20Override%20Explanation.md). This doc is only the "where to edit" list.

## The version is recorded in three coupled values

A vite-plus bump moves three distinct version strings, each in more than one file:

- **`vite-plus`** itself — the package that ships the `vp` binary (currently `0.3.0`).
- **`@voidzero-dev/vite-plus-core`** — the `vite` alias vite-plus depends on. Must match the core that _this_ `vite-plus` depends on, **not** the newest core on npm (see the Explanation's "Re-pinning" section).
- **`vitest`** — the real vitest vite-plus bundles (currently `4.1.11`). Read its target from `vp --version`, not by guessing.

## Every place to edit

| #   | File                                                                             | Key                           | Current value                             | Holds     |
| --- | -------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------- | --------- |
| 1   | [pnpm-workspace.yaml](../../pnpm-workspace.yaml)                                 | catalog `vite-plus:`          | `^0.3.0`                                  | vite-plus |
| 2   | [pnpm-workspace.yaml](../../pnpm-workspace.yaml)                                 | catalog `vite:`               | `npm:@voidzero-dev/vite-plus-core@^0.3.0` | core      |
| 3   | [pnpm-workspace.yaml](../../pnpm-workspace.yaml)                                 | catalog `vitest:`             | `4.1.11`                                  | vitest    |
| 4   | [package.json](../../package.json)                                               | `pnpm.overrides.vite`         | `npm:@voidzero-dev/vite-plus-core@0.3.0`  | core      |
| 5   | [package.json](../../package.json)                                               | `pnpm.overrides.vitest`       | `4.1.11`                                  | vitest    |
| 6   | [.claude/hooks/session-start.sh](../../.claude/hooks/session-start.sh)           | `pnpm install -g vite-plus@…` | `0.3.0`                                   | vite-plus |
| 7   | [.devcontainer/postCreateCommand.sh](../../.devcontainer/postCreateCommand.sh)   | `pnpm install -g vite-plus@…` | `0.3.0`                                   | vite-plus |
| 8   | [.devcontainer/cloud-setup-script.sh](../../.devcontainer/cloud-setup-script.sh) | `pnpm install -g vite-plus@…` | `0.3.0`                                   | vite-plus |

Rows 1–3 are ranges (the catalog convention); rows 4–8 are exact pins. The catalog carries the range and the override + bootstrap scripts carry the exact resolved version — widening the catalog range alone does nothing, because an exact override outranks it. The three bootstrap-script pins (rows 6–8) are hand-kept in lockstep because there is no way to reference the catalog from a global `pnpm install -g`; they must equal the version the lockfile resolves.

## Steps

1. Edit rows 1–5 to the new versions. Set the override `vite` core to the core that the new `vite-plus` depends on (not the newest on npm), and the `vitest` values to what `vp --version` reports for the new release.
2. Edit the `vite-plus@…` pin in rows 6–8 to the new exact version.
3. Run `vp install`, then verify there is exactly one core:

   ```bash
   grep -oE "@voidzero-dev/vite-plus-core@[0-9.]+" pnpm-lock.yaml | sort -u   # expect one line
   ```

4. Build before you lint (an unbuilt workspace floods `vp lint` with `TS2307` that buries the real split errors):

   ```bash
   vp run pack && vp check
   ```

## Related, but versioned independently

- **`voidzero-dev/setup-vp@vX.Y.Z`** in the [CI workflows](../../.github/workflows/) installs `vp` on the runners. It tracks its own release line (Dependabot bumps it separately) and is not the vite-plus version — it only needs to be new enough to run the pinned vite-plus. No manual sync with the rows above.
- **`@typescript/native-preview` and `@tsdown/css`** are installed on the same `pnpm install -g` lines as vite-plus (rows 6–8) but are separate tools with their own catalog entries (`@typescript/native-preview`, `@tsdown/css` in [pnpm-workspace.yaml](../../pnpm-workspace.yaml)). The catalog carries a range; the scripts pin the exact version `pnpm-lock.yaml` resolves for it, so a caret in the script would let the global drift ahead of the lockfile. Re-sync those pins when the lockfile resolution moves, independently of a vite-plus bump.

## See Also

- [Version Override Explanation](./Version%20Override%20Explanation.md) — why the `vite`/`vitest` overrides exist and how to diagnose a variant split
- [pnpm-workspace.yaml](../../pnpm-workspace.yaml) — catalog definitions
- [package.json](../../package.json) — `pnpm.overrides`
