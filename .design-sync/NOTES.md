# design-sync notes — react-tundraish → "Tundraish Design System"

Project: https://claude.ai/design/p/89c8cb47-f40c-4311-a4f5-ada94f3e88ef
Shape: package (no Storybook). DS package: `global/react-tundraish`. 15 components.

## Build facts

- **Entry**: `global/react-tundraish/dist/index.js` (built by `vp pack`; `dist/` is committed-fresh in CI/local).
- **`--node-modules ./node_modules`** (repo root) — react/react-dom/@types/react are pnpm-hoisted there; the package's own `node_modules` is sparse.
- **Build command** to refresh dist before re-sync: `pnpm -F "react-tundraish..." build` (the `...` pulls workspace deps). `dist/` was already fresh at first sync, so no rebuild was needed.
- Converter deps + playwright install into `.ds-sync/` with `COREPACK_ENABLE_STRICT=0`. Chromium cache: `~/Library/Caches/ms-playwright` (macOS — NOT `~/.cache`). playwright 1.61.0 matches the cached `chromium-1228` build.

## Repo change required for detection (already applied, in the PR)

`global/react-tundraish/package.json` had **no `types`/`typings` field** (its `exports["."]` only had `source` + `default`, matching the other `global/*` packages). The converter's `.d.ts` parser (`projectFor` in lib/dts.mjs) reads `pkgJson.types`/`typings` directly — with neither set it fell back to a non-existent root `index.d.ts` and found **0 components** (`[ZERO_MATCH]`), even though `dist/index.d.ts` correctly exports all 15.

Fix: added `"types": "./dist/index.d.ts"` (top-level) **and** a `types` condition inside `exports["."]`. Verified: detects all 15. This also helps any TS consumer of the published package. Note it diverges from the sibling `global/*` packages, which still omit `types` — consider applying the same to them if they're ever published for TS consumers.

## Styling idiom (tundra-css utility classes)

The DS is **tundra-css**-styled. Token + utility-class source: `node_modules/tundra-css/index.css` (v0.14.0) → synced as `tokens/index.css`. Component module CSS (hashed, e.g. `.P0sZCG_field`) ships in `dist/style.css` → synced as `_ds_bundle.css`. Both reach designs via `styles.css`'s `@import` closure.

- Text: `text-body-{1..4}`, `text-label-{1..4}`.
- Inputs: `input-{1..4}` (apps use `input-2`). Checkboxes/radios: `checkbox-{1..4}`, `radio-{1..4}` on the `<input>`.
- Buttons: `.button`, filled/outline variants; accents `accent-{red,blue,green,…}` / `app-{color}` to repoint the `--app-accent-*` chain.
- Dark mode: `:root[data-color-scheme='dark']` attribute (set in JS), not `prefers-color-scheme`.
- No custom `@font-face` anywhere — tundra uses system font stacks + `--font-size-*`/`--font-weight-*` tokens. No fonts to ship; `fonts/` is empty by design (not a `[FONT_MISSING]` to chase).

## Component-specific findings

- **`.checkbox-row`** (Checkbox's wrapper layout class) is **defined in NO shipped stylesheet** (not tundra-css, not dist/style.css, nowhere in the repo). The component expects the *host app* to supply the row's flex+gap, so the box and label sit flush. This is faithful shipped behavior, not a preview bug — graded `good`. If a future maintainer wants the gap to ship, define `.checkbox-row` in react-tundraish's own module CSS.
- **Menu** is an internal-state dropdown (`useState(open)`); closed by default → its floor card was blank. Authored preview opens it via an on-mount `button.click()` in the `Opened` cell. Config: `overrides.Menu = {cardMode:'single', primaryStory:'Opened', viewport:'360x300'}` so the open list renders in-card instead of escaping/collapsing.
- Rich real usage to author from lives in the apps/slices (no docs/examples dir in the package): gatekeeper-react, collector-react, tunnel-react, wildflower-react routes. Menu usage: `slices/gatekeeper/.../settings/gatekeeper/index.tsx` and `slices/collector/.../collector/index.tsx`.

## Authored-preview lint noise (harmless)

Files in `.design-sync/previews/*.tsx` import from `'react-tundraish'` (the converter aliases it to `window.ReactTundraish`) and use multiple named exports / no explicit return types. The repo's oxlint/tsc will flag these (module-not-found, no-any, single-export, return-type). They are NOT repo sources — the converter's own esbuild compiles them. Ignore the editor diagnostics; do not "fix" them to repo style or the cell convention breaks.

## Known render warns (triaged-legitimate)

(none yet — Field/FieldGroup `thin` and Menu `blank` were floor-card warns that disappear once their previews are authored. Re-check after the full author pass.)

## Progress at handoff (2026-06-18)

First sync was interrupted partway for time. State:
- Bundle + validate clean (exit 0), 15 components, anchor written.
- Uploaded (incremental plan `finalize_plan` approved; planId is session-scoped, will need re-approval on resume):
  - **Batch 1**: shared base (`_ds_bundle.js/.css`, `styles.css`, `README.md`, `_vendor/`, `tokens/`) + 5 auto/floor components: AsyncErrorView, Awaited, ErrorBoundary, PageBodyError, PageLoading.
  - **Batch 2 (solo trio)**: Checkbox, Field, Menu — authored, graded all `good`, pushed.
- **Still on floor cards / not yet authored**: Dialog, ItemList, PageHeader, RadioGroup, StatusBadge, FieldDescription, FieldGroup. (FieldGroup/FieldDescription are composed inside Field's preview but have no own authored `.tsx` yet — still floor cards as standalone components.)
- Conventions header (`.design-sync/conventions.md`) NOT yet authored.
- Close-out (full content write + reconciliation deletes + final `_ds_sync.json` anchor) NOT yet done — **the project is currently un-anchored**, which is the documented safe state: next sync re-verifies everything.

## Re-sync risks / watch-list

- The upload plan (`finalize_plan`) is session-scoped — a resumed sync must re-approve it. Resuming arrives **pinned** (config has `projectId`) so it routes to the **atomic** path, not incremental — that's expected.
- `dist/` must be fresh before the converter runs; `pnpm -F "react-tundraish..." build` if the DS source changed.
- The `types` field fix lives in the repo (committed) — if it's ever reverted, detection breaks again with `[ZERO_MATCH]`.
- Grades for Checkbox/Field/Menu live in `.design-sync/.cache/review/` (gitignored). They are NOT carried across machines until the project's `_ds_sync.json` anchor is written by a completed close-out. A resume on this machine reuses them; a fresh clone re-grades.
- `tundra-css` is a published catalog dep pinned `^0.14.0` — a token rename upstream would shift the styling vocabulary in this NOTES file.
