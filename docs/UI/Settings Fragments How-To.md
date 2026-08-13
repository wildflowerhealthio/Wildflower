# Settings Fragments How-To

How to opt a slice into the unified `/settings` surface introduced in issue [#47](https://github.com/Assessment-is/Wildflower/issues/47).

## Goal

You want a slice's owner-facing screens to live under `/settings/<slice>/…` and show up as a row on the aggregated `/settings` landing in `apps/wildflower-react`. The pattern composes at compile time — no runtime registry — so the only contract is two named exports from the slice's `*-react` package.

## Steps

### 1. Export the routes fragment

In `slices/<name>/<name>-react/src/routes.tsx`, declare a `JSX.Element` named `<name>SettingsRoutesFragment` containing one or more `<Route>` children with absolute paths under `/settings/<name>/`.

```tsx
import type { JSX } from 'react'
import { Route } from 'react-router'
import { MyScreen } from './screens/my-screen.tsx'

const exampleSettingsRoutesFragment: JSX.Element = (
  <>
    <Route path="/settings/example" element={<MyScreen />} />
    <Route path="/settings/example/detail/:id" element={<MyDetailScreen />} />
  </>
)

export { exampleSettingsRoutesFragment }
```

Re-export from the slice's `src/index.ts`.

> Use **absolute paths**, not relative ones. React Router walks `<Routes>` children syntactically, so each `<Route>` mounts where it's declared regardless of nesting depth. Matching the pattern used by every existing `*RoutesFragment` keeps composition mechanical.

### 2. Export the items fragment

In `slices/<name>/<name>-react/src/settings-fragments.tsx`, declare a `readonly SettingsItem[]` named `<name>SettingsItemsFragment`. Each item's `href` should match a route declared in step 1 (typically the index landing for the slice).

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

### 3. Wire the slice into `apps/wildflower-react`

In `apps/wildflower-react/src/routes.tsx`:

```tsx
import { exampleSettingsRoutesFragment } from 'example-react'
// …
;<Route element={<AuthorizedAppShell />}>
  {/* … other fragments … */}
  <Route path="/settings" element={<SettingsScreen />} />
  {exampleSettingsRoutesFragment}
</Route>
```

In `apps/wildflower-react/src/screens/settings-screen.tsx`, spread the new items fragment alongside the others. Fragment-declaration order is canonical in v1 — there is no sorting layer.

```tsx
import { exampleSettingsItemsFragment } from 'example-react'

const settingsItems: readonly SettingsItem[] = [
  ...tunnelSettingsItemsFragment,
  ...exampleSettingsItemsFragment, // appears under Tunnel in the menu
  // …
]
```

Add the slice's package to `apps/wildflower-react`'s `dependencies` if it isn't already.

### 4. Update internal navigations

`grep` the slice for hardcoded path literals (`'/<slice>'`, `` `/<slice>/…` ``) — every `navigate('/old')`, `useSearchParams` redirect, or inline link target needs to point at the new `/settings/<slice>/…` path.

### 5. Update the drift test

The slice's `tests/routes.test.tsx` is a source-text drift test that checks fragment names + path literals via regex. Update it:

- Rename the bucket variable from `authorizedRoutePaths` (or similar) to `settingsRoutePaths`.
- Update path assertions to the new `/settings/<slice>/…` literals.
- Assert every settings path is under `/settings/<slice>/` (no stragglers).

Add a small `tests/settings-fragments.test.ts` that imports the items fragment and asserts shape (length, `href`, `id`).

### 6. Migrating a slice that previously had a top-level URL

If the slice was at `/<slice>` before, the move is a **clean rename** — no redirect. The decision (issue #47) was that old paths 404 rather than alias forward, to keep slice boundaries crisp.

## Variations

- **Slice has externally-published URLs** (OAuth callbacks, redirect targets, RFC 8628 device flows): keep those routes at their original prefix; only the owner-facing landings move under `/settings/<slice>/`. Moving a published route would change the URL other parties already hold — for the device flow that URL is the `verification_uri`, built in **both** `gatekeeper-core/page-paths.ts` and `gatekeeper-rust/http/page_paths.rs` (drift-tested), so moving it would also touch Rust.
- **A flow needs both a published URL and an owner-facing entry — use an inside-`/settings` twin, don't move it.** Lift the inner content out of the route into a **header-less, parameterized** component (`onSubmit`/`onDone`), then render it from **two** routes: the public one (no back link) and an owner-facing `/settings/…` twin (with a `backHref`). Same inner content, different chrome — the published URL and the Rust side stay untouched. Gatekeeper's device-authorization flow is canonical: the inner forms live in `gatekeeper-react/src/screens/device/` and `screens/device-consent/`, and are rendered from both `routes/_open/gatekeeper/devices.tsx` (published, headerless) and `routes/settings/gatekeeper/devices.tsx` (owner-facing, back link to the access page). Name the consent twin `devices_.$userCode.tsx` (trailing `_`) so it sits as a **sibling** of the entry route rather than nesting under the headerless `devices.tsx` — the same trick as `requests.tsx` / `requests_.$id.tsx`.
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
