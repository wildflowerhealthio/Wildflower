# Settings Fragments How-To

How to opt a slice into the unified `/settings` surface introduced in issue [#47](https://github.com/Assessment-is/Wildflower/issues/47).

## Goal

You want a slice's owner-facing screens to live under `/settings/<slice>/…` and show up as a row on the aggregated `/settings` landing in `apps/launcher/launcher-web`. The pattern composes at compile time — no runtime registry — so the contract is a `routes/settings/<slice>/` route directory and one named export from the slice's `*-react` package.

## Steps

### 1. Add the settings routes

Put the screens under `src/routes/settings/<name>/` in the slice's `*-react` package, as TanStack Router file routes (see `apps/launcher/databases/databases-react/src/routes/settings/databases/index.tsx`). The package's own `vite.config.ts` runs the route generator over `src/routes`, and the launcher mounts the `settings` bucket under its `/settings` route, so `settings/<name>/index.tsx` serves `/settings/<name>`.

### 2. Export the items fragment

In `<name>-react/src/settings-fragments.ts`, declare a `readonly SettingsItem[]` named `<name>SettingsItemsFragment`. Each item's `href` should match a route from step 1 (typically the index landing for the slice).

```ts
import type { SettingsItem } from 'shared-structures-react'

const exampleSettingsItemsFragment: readonly SettingsItem[] = [
  {
    id: 'example',
    title: 'Example',
    subtitle: 'One-line description that appears under the title',
    href: '/settings/example',
  },
]

export { exampleSettingsItemsFragment }
```

Re-export from the slice's `src/index.ts`. Add `shared-structures-react` to the slice's `peer` + `devDependencies` if it isn't already present.

`SettingsItem` is the `href`-required branch of `ItemListItem` (from `react-tundraish`) — items pass straight to `<ItemList>` with no transformation. Optional fields (`subtitle`, `badge`, `disabled`, `actions`) work as in `ItemListItem`.

### 3. Wire the slice into `apps/launcher/launcher-web`

In `apps/launcher/launcher-web/routes.config.ts`, mount the slice's `settings` bucket under the `/settings` route, beside the others:

```ts
route('/settings', 'settings.tsx', [
  index('settings/index.tsx'),
  // …
  physical('', sliceRoutesDir('example', 'settings')),
]),
```

(`launcherRoutesDir` instead, for a package in `apps/launcher/`.) In `apps/launcher/launcher-web/src/routes/settings/index.tsx`, spread the new items fragment alongside the others. Fragment-declaration order is canonical in v1 — there is no sorting layer.

```tsx
import { exampleSettingsItemsFragment } from 'example-react'

const sliceSettingsItems: readonly SettingsItem[] = [
  ...requestLogSettingsItemsFragment,
  ...exampleSettingsItemsFragment, // appears under Request log in the menu
  // …
]
```

Add the slice's package to `apps/launcher/launcher-web`'s `dependencies` if it isn't already.

### 4. Update internal navigations

`grep` the slice for hardcoded path literals (`'/<slice>'`, `` `/<slice>/…` ``) — every `navigate`, redirect or inline link target needs to point at the new `/settings/<slice>/…` path.

### 5. Test the items fragment

Add a small `src/settings-fragments.test.ts` that imports the items fragment and asserts shape (length, `href`, `id`), as `databases-react` does.

### 6. Migrating a slice that previously had a top-level URL

If the slice was at `/<slice>` before, the move is a **clean rename** — no redirect. The decision (issue #47) was that old paths 404 rather than alias forward, to keep slice boundaries crisp.

## Variations

- **Slice has externally-published URLs** (OAuth callbacks, redirect targets, RFC 8628 device flows): keep those routes at their original prefix; only the owner-facing landings move under `/settings/<slice>/`. Moving a published route would change the URL other parties already hold — for the device flow that URL is the `verification_uri`, which `gatekeeper-rust`'s `domain/page_paths.rs` builds on the hosted launcher from the same route `gatekeeper-core/page-paths.ts` names for the React router, so moving it would also touch Rust.
- **A flow needs both a published URL and an owner-facing entry — use an inside-`/settings` twin, don't move it.** Lift the inner content out of the route into a **header-less, parameterized** component (`onSubmit`/`onDone`), then render it from **two** routes: the public one (no back link) and an owner-facing `/settings/…` twin (with a `backHref`). Same inner content, different chrome — the published URL and the Rust side stay untouched. Gatekeeper's device-authorization flow is canonical: the inner forms live in `gatekeeper-react/src/screens/device/` and `screens/pending-consent/`, and are rendered from both `routes/_open/gatekeeper/devices.tsx` (published, headerless) and `routes/settings/gatekeeper/devices.tsx` (owner-facing, back link to the access page). Name the consent twin `devices_.$userCode.tsx` (trailing `_`) so it sits as a **sibling** of the entry route rather than nesting under the headerless `devices.tsx` — the same trick as `requests.tsx` / `requests_.$id.tsx`.
- **Slice has multiple top-level items**: nothing forbids it. `<name>SettingsItemsFragment` is a `readonly SettingsItem[]`; declare as many entries as you need. Each should link into the slice's settings routes.
- **Slice has no `*-react` package today**: the pattern is `-react`-scoped. Add a `-react` package first, then opt in.

## Out of scope (still v1)

- Section grouping / per-slice section headers — items render as one flat list.
- Sort order — preserve fragment-declaration order; sorting is a future v2 concern.
- Icons or structured `badge: { kind: 'info' | 'warn' | 'error'; label }` — both deferred. Today, `badge` is `ReactNode` per `ItemListItem`.
- Per-item platform gating (`requires?: 'host:node'`) — also deferred.

## See also

- [`SettingsItem` definition](../../slices/shared-structures/shared-structures-react/src/settings-item.ts) — the type itself
- [`react-tundraish/ItemList`](../../global/react-tundraish/src/item-list.tsx) — the rendering primitive items pass through to
- [Issue #47](https://github.com/Assessment-is/Wildflower/issues/47) — design rationale and open questions
