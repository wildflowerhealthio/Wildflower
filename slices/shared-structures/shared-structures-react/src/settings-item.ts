import type { ItemListItem } from 'react-tundraish'

/**
 * One entry in the unified `/settings` menu.
 *
 * Each slice's `*-react` package exports
 * `<slice>SettingsItemsFragment: readonly SettingsItem[]`, which
 * `apps/wildflower-react/src/routes/settings/index.tsx` concatenates
 * and feeds straight into `<ItemList>` from `react-tundraish`. The
 * shape is the navigational (`href`) and action (`onClick`, e.g.
 * `main-web`'s bearer logout) branches of `ItemListItem`, so no
 * transformation is needed — the two variants a settings row can be.
 *
 * @remarks
 * Icons and a structured `{ kind, label }` badge are v2 concerns
 * (issue #47). Today, `badge` is `ReactNode` per `ItemListItem`.
 */
type SettingsItem = Extract<
  ItemListItem,
  { readonly href: string } | { readonly onClick: () => void }
>

export type { SettingsItem }
