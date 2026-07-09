import type { SettingsItem } from 'shared-structures-react'

/**
 * Menu entries the unified `/settings` screen renders for apps.
 *
 * `apps/wildflower-react/src/routes/settings/index.tsx` concatenates this with
 * every other slice's `*SettingsItemsFragment` and feeds the result to
 * `<ItemList>`. The `href` mirrors the index path declared by the slice's
 * `routes/settings/apps` subtree (no trailing slash, matching the other
 * slices' menu hrefs).
 */
const appsSettingsItemsFragment: readonly SettingsItem[] = [
  {
    id: 'apps',
    title: 'Apps',
    subtitle: 'Add, remove, and configure the apps on your home screen',
    href: '/settings/apps',
  },
]

export { appsSettingsItemsFragment }
