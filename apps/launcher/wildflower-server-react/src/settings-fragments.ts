import type { SettingsItem } from 'shared-structures-react'

/**
 * The Settings row for `/settings/server`.
 *
 * @remarks
 * Not one of the rows `apps/launcher/launcher-web`'s `/settings` index concatenates
 * for every entry: only the Tauri host runs the server, so `main-tauri` passes
 * this as its `platformSettingsItems`. The `href` is the path
 * `src/routes/settings/server/index.tsx` mounts.
 */
const backgroundServerServiceSettingsItemsFragment: readonly SettingsItem[] = [
  {
    id: 'server',
    title: 'Server',
    subtitle: 'The Wildflower server running on this device',
    href: '/settings/server',
  },
]

export { backgroundServerServiceSettingsItemsFragment }
