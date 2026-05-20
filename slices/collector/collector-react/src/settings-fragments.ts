import type { SettingsItem } from 'shared-structures-react'

/**
 * Menu entries the unified `/settings` screen renders for collector.
 *
 * `apps/wildflower-react/src/screens/settings-screen.tsx`
 * concatenates this with every other slice's
 * `*SettingsItemsFragment` and feeds the result to `<ItemList>`. The
 * `href` mirrors the path declared by `collectorSettingsRoutesFragment`
 * in `./routes.tsx`.
 */
const collectorSettingsItemsFragment: readonly SettingsItem[] = [
  {
    id: 'collector',
    title: 'Collector',
    subtitle: 'Connect FHIR accounts to import patient data',
    href: '/settings/collector',
  },
]

export { collectorSettingsItemsFragment }
