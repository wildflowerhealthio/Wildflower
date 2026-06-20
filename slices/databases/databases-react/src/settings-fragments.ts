import type { SettingsItem } from 'shared-structures-react'

/**
 * Menu entries the unified `/settings` screen renders for data management.
 *
 * `apps/wildflower-react/src/routes/settings/index.tsx` concatenates this with
 * every other slice's `*SettingsItemsFragment` and feeds the result to
 * `<ItemList>`. The `href` mirrors the path declared by the slice's
 * `routes/settings/databases` subtree.
 */
const databasesSettingsItemsFragment: readonly SettingsItem[] = [
  {
    id: 'databases',
    title: 'Your data',
    subtitle: 'Download or delete your health data and app databases',
    href: '/settings/databases',
  },
]

export { databasesSettingsItemsFragment }
