import type { SettingsItem } from 'shared-structures-react'

/**
 * Menu entries the unified `/settings` screen renders for the request log.
 *
 * `apps/wildflower-react/src/routes/settings/index.tsx` concatenates this with
 * every other slice's `*SettingsItemsFragment` and feeds the result to
 * `<ItemList>`. The `href` mirrors the slice's `routes/settings/requests` page.
 */
const requestLogSettingsItemsFragment: readonly SettingsItem[] = [
  {
    id: 'requests',
    title: 'Requests',
    subtitle: 'Requests that came through the tunnel, and how each fared',
    href: '/settings/requests',
  },
]

export { requestLogSettingsItemsFragment }
