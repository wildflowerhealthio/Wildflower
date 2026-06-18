# design-sync notes — react-tundraish → "Tundraish Design System"

Project: https://claude.ai/design/p/89c8cb47-f40c-4311-a4f5-ada94f3e88ef
Shape: package (no Storybook). DS package: `global/react-tundraish`. 15 components.

## Build facts

- **Entry**: `global/react-tundraish/dist/index.js` (built by `vp pack`). `dist/` is **gitignored** (root `.gitignore` ignores `dist`), so on a fresh clone it won't exist until you build — run the build command below before the converter runs.
- **`--node-modules ./node_modules`** (repo root) — react/react-dom/@types/react are pnpm-hoisted there; the package's own `node_modules` is sparse.
- **Build command** to produce/refresh dist before re-sync: `vp run -F "react-tundraish..." build` (the `...` pulls workspace deps). Drive the build through `vp`, never `pnpm` directly (repo toolchain rule).
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

- **`.checkbox-row`** (Checkbox's wrapper layout class) is **defined in NO shipped stylesheet** (not tundra-css, not dist/style.css, nowhere in the repo). The component expects the *host app* to supply the row's flex+gap, so the box and label sit flush. This is faithful shipped behavior, not a preview bug — graded `good`. If a future maintainer wants the gap to ship, define `.checkbox-row` in react-tundraish's own module CSS. The same flush look appears in **RadioGroup** and **FieldGroup** (radio/checkbox rows) — same root cause, same `good` grade.
- **StatusBadge — DEFERRED TO FLOOR CARD (user decision, 2026-06-18).** `src/status-badge.tsx` renders `<span className="status-badge accent-{green|blue|yellow|red}">` plus an `.sr-only` prefix span. **Neither `.status-badge` nor `.sr-only` is defined in any shipped stylesheet** (not tundra-css, not dist/style.css, and no consuming app defines them either — verified repo-wide). Result: the badge renders as unstyled inline text with NO pill/tone color, and the screen-reader prefixes ("Success: ", "Warning: ", "Error: ") leak as VISIBLE text. Unlike `.checkbox-row` (a minor gap), this leaves the badge with no visual identity, so it would teach the design agent to imitate an unstyled badge. Decision: **do not author a StatusBadge preview** — let it fall back to the honest floor card (the bundle/`.d.ts`/`.prompt.md` still ship; StatusBadge is fully functional, just no rich preview). The `.design-sync/previews/StatusBadge.tsx` authored by the cloud agent was removed. **To author it later**: first ship `.status-badge` (pill: padding/radius/background driven by the `accent-*` token chain) and `.sr-only` (visually-hidden) in react-tundraish's own CSS, rebuild, then re-author the preview (its cells were ConnectionStatus / InlineWithTitle / Tones, composed from `slices/tunnel/.../TunnelToggle.tsx` and `slices/gatekeeper/.../requests_.$id.tsx`).
- **Menu** is an internal-state dropdown (`useState(open)`); closed by default → its floor card was blank. Authored preview opens it via an on-mount `button.click()` in the `Opened` cell. Config: `overrides.Menu = {cardMode:'single', primaryStory:'Opened', viewport:'360x300'}` so the open list renders in-card instead of escaping/collapsing.
- **Dialog** is an overlay (native `<dialog>` via `showModal()`); its floor card is blank because the modal isn't shown. Authored preview holds `open` true on mount. Config: `overrides.Dialog = {cardMode:'single', primaryStory:'Confirm', viewport:'420x300'}`, mirroring Menu. The `Blocking` story shows the non-dismissable variant.
- **PageHeader** renders a TanStack `<Link to={backHref}>` for its back affordance (`src/page-header.tsx` imports `Link` from `@tanstack/react-router`). Outside a `RouterProvider`, `<Link>` reads router context and throws `Cannot read properties of null (reading 'stores')` — only the `backHref` cells fail (title/subtitle/actions render fine). **Decision (user, 2026-06-18): drop the `backHref` cells** rather than wrap previews in a memory RouterProvider. Preview cells are now TopLevel / WithSubtitle / WithActions / Truncating — no back link. The `backHref`/`backLabel` props stay documented in `PageHeader.d.ts`; only the preview omits them. If a future maintainer wants the back arrow shown, wire a TanStack memory router via `cfg.provider` + `$ref` + `extraEntries`.
- **ItemList** also imports `@tanstack/react-router` `Link` (renders one for `href` items starting with `/`; plain `<a>` otherwise, `onClick` items need no link). Its authored preview avoids the routed `/`-href path, so it renders clean with no provider. Same RouterProvider caveat applies if a future cell uses an absolute-path `href`.
- **Field / FieldDescription** tripped `[GRID_OVERFLOW]` (`wide`) — their stories render wider than a grid cell. Fixed with `overrides.{Field,FieldDescription} = {cardMode:'column'}` (one story per row, full card width). `column` can't re-flag `wide`, so no confirming re-validate needed.
- Rich real usage to author from lives in the apps/slices (no docs/examples dir in the package): gatekeeper-react, collector-react, tunnel-react, wildflower-react routes. Menu usage: `slices/gatekeeper/.../settings/gatekeeper/index.tsx` and `slices/collector/.../collector/index.tsx`. ItemList/Dialog/PageHeader: `slices/collector/.../collector/index.tsx`; RadioGroup: `slices/gatekeeper/.../oauth-consent/oauth-consent-form.tsx`; StatusBadge: `slices/tunnel/.../TunnelToggle.tsx` and `slices/gatekeeper/.../requests_.$id.tsx`; PageHeader actions: `slices/apps/.../home/index.tsx`.

## Authored-preview lint noise (harmless)

Files in `.design-sync/previews/*.tsx` import from `'react-tundraish'` (the converter aliases it to `window.ReactTundraish`) and use multiple named exports / no explicit return types. The repo's oxlint/tsc will flag these (module-not-found, no-any, single-export, return-type). They are NOT repo sources — the converter's own esbuild compiles them. Ignore the editor diagnostics; do not "fix" them to repo style or the cell convention breaks.

## Known render warns (triaged-legitimate)

(none yet — Field/FieldGroup `thin` and Menu `blank` were floor-card warns that disappear once their previews are authored. Re-check after the full author pass — especially the new Dialog/ItemList/PageHeader/RadioGroup/StatusBadge cells.)

## SYNC COMPLETE (2026-06-18)

First sync finished and **anchored**. The project now holds all 15 components (9 authored previews graded `good`, 6 on the floor card incl. deferred StatusBadge), base bundle/styles/tokens, README with conventions header, and `_ds_sync.json` (the verification anchor — future re-syncs skip unchanged components). Upload was atomic (project was pinned + non-empty), purely additive (7 component dirs added, 0 deletes), verified via `list_files`. Render check 15/15 clean, 0 warnings. See "Re-sync risks" — previews are accepted-but-provisional (user wants a later rework pass).

---

## Progress at handoff (2026-06-18 — second pause, mid-grade) [superseded by SYNC COMPLETE above]

Resumed the interrupted first sync on the real toolchain (converter staged, dist rebuilt, playwright 1.61.0/chromium-1228 cached). **Paused by user before upload.** Current state:

- **Build + validate clean (exit 0), 15 components, render check 15/15 clean, 0 warnings.** Anchor (`_ds_sync.json`) is written *to disk in ds-bundle/* but **NOT uploaded** — the project remains **un-anchored** (safe state).
- **9 authored previews, all graded `good`** (grades in `.design-sync/.cache/review/*.grade.json`, gitignored — reused on resume on THIS machine): Checkbox, Dialog, Field, FieldDescription, FieldGroup, ItemList, Menu, PageHeader, RadioGroup. All visually verified from `_screenshots/review/` sheets this session.
- **StatusBadge: DEFERRED to floor card** (user decision — see the StatusBadge bullet under "Component-specific findings"). Its preview `.tsx` was deleted. 6 components now show the floor card (the 5 auto/error components + StatusBadge); all ship functional bundle/`.d.ts`/`.prompt.md`.
- **PageHeader: backHref cells dropped** (user decision) — see its bullet. Cells now TopLevel/WithSubtitle/WithActions/Truncating.
- **Config updated this session**: added `overrides.Field` and `overrides.FieldDescription` = `{cardMode:'column'}` (grid-overflow fix); added `overrides` were the only config change. `previews/PageHeader.tsx` rewritten; `previews/StatusBadge.tsx` removed.
- **Conventions header**: `.design-sync/conventions.md` exists, wired via `readmeHeader`; the latest build stitched it into the README. **Still TODO on resume: re-validate the header's enumerated class/token/component names against the fresh build** (the "Author the conventions header" validation pass — file exists, so validate-don't-rewrite).

### TO RESUME (atomic path — config is pinned)
1. Re-stage scripts (`cp -r` per skill §7), rebuild dist if source changed (`vp run -F "react-tundraish..." build`), re-run `package-build.mjs` + `package-validate.mjs` (entry: `./global/react-tundraish/dist/index.js`, node-modules: `./node_modules`). Output is deterministic — grades carry forward if sources unchanged.
2. Validate the conventions header against the fresh build; rebuild if it changed.
3. **Human review**: serve `ds-bundle/.review.html` (`node .ds-sync/storybook/http-serve.mjs ./ds-bundle`) and let the user skim before upload.
4. **Atomic upload (§5)**: `finalize_plan` (full writes; deletes — project is un-anchored so no diff: review remote `list_files` for paths this build doesn't produce. NOTE: remote currently has only 8 component dirs from the first sync's batches — AsyncErrorView, Awaited, Checkbox, ErrorBoundary, Field, Menu, PageBodyError, PageLoading. This build produces all 15, so the upload ADDS the missing 7; no deletes expected unless StatusBadge was uploaded before — it was not). Sentinel-fence → content writes → deletes → sentinel re-arm → `_ds_sync.json` LAST. Verify `list_files` count.
5. Commit the durable set (config.json, NOTES.md, conventions.md, previews/) + offer a PR.

## Re-sync risks / watch-list

- **Previews are accepted-but-provisional (user, 2026-06-18).** The user reviewed `.review.html` and judged all 9 authored previews "serviceable for now, but will need to be reworked later." They are graded `good` and shipped, but a future sync should plan a rework pass — likely richer/more brand-accurate compositions, and revisit the deferred StatusBadge (needs `.status-badge`/`.sr-only` CSS shipped first) and PageHeader's dropped back-link cells (needs a memory RouterProvider). Don't treat the current cards as final.
- The upload plan (`finalize_plan`) is session-scoped — a resumed sync must re-approve it. Resuming arrives **pinned** (config has `projectId`) so it routes to the **atomic** path, not incremental — that's expected.
- `dist/` is gitignored, so it must be (re)built before the converter runs; `vp run -F "react-tundraish..." build` (never `pnpm` directly) on a fresh clone or if the DS source changed.
- The `types` field fix lives in the repo (committed) — if it's ever reverted, detection breaks again with `[ZERO_MATCH]`.
- Grades for Checkbox/Field/Menu live in `.design-sync/.cache/review/` (gitignored). They are NOT carried across machines until the project's `_ds_sync.json` anchor is written by a completed close-out. A resume on this machine reuses them; a fresh clone re-grades.
- `tundra-css` is a published catalog dep pinned `^0.14.0` — a token rename upstream would shift the styling vocabulary in this NOTES file.
