import type { SettingsItem } from '@wildflowerhealthio/shared-structures-react'

import { SHOW_WALKTHROUGH_AGAIN_SEARCH } from './routes/_auth/home/-home-walkthrough.ts'

/**
 * Menu entries the unified `/settings` screen renders for apps.
 *
 * `apps/launcher/launcher-web/src/routes/settings/index.tsx` concatenates this with
 * every other slice's `*SettingsItemsFragment` and feeds the result to
 * `<ItemList>`. Apps manages the catalogue: its `href` mirrors the index path
 * declared by the slice's `routes/settings/apps` subtree (no trailing slash,
 * matching the other slices' menu hrefs). Arrange home screen opens the home
 * screen itself with `?edit=true` (`routes/_auth/home/index.tsx`'s
 * `HomeSearch`), where the apps on it drag to reorder and hide. Show
 * walkthrough again opens it with `?walkthrough=show`, which shows the
 * launcher's walkthrough (`routes/_auth/home/-home-walkthrough.ts`) again.
 */
const appsSettingsItemsFragment: readonly SettingsItem[] = [
  {
    id: 'apps',
    title: 'Apps',
    subtitle: 'Add, remove, and configure the apps on your home screen',
    href: '/settings/apps',
  },
  {
    id: 'home-screen',
    title: 'Arrange home screen',
    subtitle: 'Reorder the apps on your home screen, or hide them',
    href: '/home',
    search: { edit: true },
  },
  {
    id: 'walkthrough',
    title: 'Show walkthrough again',
    href: '/home',
    search: SHOW_WALKTHROUGH_AGAIN_SEARCH,
  },
]

export { appsSettingsItemsFragment }
