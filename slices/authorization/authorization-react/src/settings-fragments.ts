import type { SettingsItem } from '@wildflowerhealthio/shared-structures-react'

/**
 * Menu entries the unified `/settings` screen renders for gatekeeper.
 *
 * `apps/launcher/launcher-web/src/routes/settings/index.tsx`
 * concatenates this with every other slice's
 * `*SettingsItemsFragment` and feeds the result to `<ItemList>`.
 *
 * Only the index landing is exposed here; the request list /
 * request detail / approved-app detail screens are deep-linked from
 * `<AccessIndexScreen />` and don't get their own top-level menu
 * entries. The `href` mirrors the index path declared by
 * `authorizationSettingsRoutesFragment` in `./routes.tsx`.
 */
const authorizationSettingsItemsFragment: readonly SettingsItem[] = [
  {
    id: 'authorization',
    title: 'Access',
    subtitle: 'Manage apps and devices access to your data',
    href: '/settings/authorization',
  },
]

export { authorizationSettingsItemsFragment }
