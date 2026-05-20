import type { SettingsItem } from 'shared-structures-react'

/**
 * Menu entries the unified `/settings` screen renders for tunnel.
 *
 * `apps/wildflower-react/src/screens/settings-screen.tsx`
 * concatenates this with every other slice's
 * `*SettingsItemsFragment` and feeds the result to `<ItemList>`. The
 * `href` mirrors the path declared by `tunnelSettingsRoutesFragment`
 * in `./routes.tsx`.
 */
const tunnelSettingsItemsFragment: readonly SettingsItem[] = [
  {
    id: 'tunnel',
    title: 'Tunnel',
    subtitle: 'Expose this device to the public Internet',
    href: '/settings/tunnel',
  },
]

export { tunnelSettingsItemsFragment }
