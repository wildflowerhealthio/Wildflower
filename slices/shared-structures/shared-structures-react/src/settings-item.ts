import type { ItemListItem } from 'react-tundraish'

/**
 * One entry in the unified `/settings` menu.
 *
 * Each slice's `*-react` package exports
 * `<slice>SettingsItemsFragment: readonly SettingsItem[]`, which
 * `apps/wildflower-react/src/screens/settings-screen.tsx` concatenates
 * and feeds straight into `<ItemList>` from `react-tundraish`. The
 * shape is the `href`-required branch of `ItemListItem` so no
 * transformation is needed.
 *
 * @remarks
 * Icons and a structured `{ kind, label }` badge are v2 concerns
 * (issue #47). Today, `badge` is `ReactNode` per `ItemListItem`.
 */
type SettingsItem = Extract<ItemListItem, { readonly href: string }>

export type { SettingsItem }
