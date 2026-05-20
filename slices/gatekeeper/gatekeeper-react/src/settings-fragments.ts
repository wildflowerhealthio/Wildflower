import type { SettingsItem } from 'shared-structures-react'

/**
 * Menu entries the unified `/settings` screen renders for gatekeeper.
 *
 * `apps/wildflower-react/src/screens/settings-screen.tsx`
 * concatenates this with every other slice's
 * `*SettingsItemsFragment` and feeds the result to `<ItemList>`.
 *
 * Only the index landing is exposed here; the request list /
 * request detail / approved-app detail screens are deep-linked from
 * `<AccessIndexScreen />` and don't get their own top-level menu
 * entries. The `href` mirrors the index path declared by
 * `gatekeeperSettingsRoutesFragment` in `./routes.tsx`.
 */
const gatekeeperSettingsItemsFragment: readonly SettingsItem[] = [
  {
    id: 'gatekeeper',
    title: 'Access',
    subtitle: 'Manage app grants and approved devices',
    href: '/settings/gatekeeper',
  },
]

export { gatekeeperSettingsItemsFragment }
