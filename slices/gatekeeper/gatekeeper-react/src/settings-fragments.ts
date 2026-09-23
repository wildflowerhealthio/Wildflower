import type { SettingsItem } from 'shared-structures-react'

/**
 * Menu entries the unified `/settings` screen renders for gatekeeper.
 *
 * `apps/wildflower-react/src/routes/settings/index.tsx`
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
    subtitle: 'Manage apps and devices access to your data',
    href: '/settings/gatekeeper',
  },
]

/**
 * The **same-origin cookie** "Logout" settings row. Ends a cookie session by
 * POSTing to `/access/logout`, where gatekeeper-rust clears the `wf_auth` +
 * `wf_auth_exp` cookies and 303s home.
 *
 * No in-tree entry uses it: `main-web` runs cross-origin with a bearer and has
 * its own action row (`apps/wildflower-react/src/bearer-logout.ts`). It stays
 * with the rest of the cookie-session machinery until that is removed.
 *
 * A real same-origin `<form method="post">` (the `formAction` variant), NOT a
 * link: a GET logout would be CSRF-able, since a `SameSite=Lax` cookie IS
 * carried on a cross-site top-level GET navigation. POST closes that hole.
 *
 * Deliberately NOT part of {@link gatekeeperSettingsItemsFragment}: it's
 * meaningful only on the standalone-web entries. On Tauri the session is
 * connection-provenance (the host's loopback-owner trust re-authenticates every
 * request), so clearing a cookie is a no-op — and the page origin there doesn't
 * even serve `/access/logout`.
 */
const gatekeeperLogoutSettingsItem: SettingsItem = {
  id: 'logout',
  title: 'Logout',
  subtitle: 'Log out of Wildflower and clear the session.',
  formAction: '/access/logout',
  method: 'post',
}

export { gatekeeperLogoutSettingsItem, gatekeeperSettingsItemsFragment }
