type TabKey = 'apps' | 'collector' | 'settings'

interface TabSpec {
  readonly key: TabKey
  readonly label: string
  readonly path: string
}

/**
 * The three top-level surfaces the persistent shell exposes. The order
 * here is a presentation concern (left-to-right in the tab bar).
 * Pathnames that don't match any tab return `null` from {@link tabForPath}.
 */
const TABS: ReadonlyArray<TabSpec> = [
  { key: 'apps', label: 'Apps', path: '/home' },
  { key: 'collector', label: 'Collector', path: '/collector' },
  { key: 'settings', label: 'Settings', path: '/settings' },
]

/**
 * Map an in-SPA pathname (emitted by `NavigationBridge.RouteChanged`)
 * to the tab that should appear active. A pathname matches a tab when
 * it equals the tab's path exactly OR is a descendant (prefix match
 * on `path/`). Unrecognized paths fall back to null.
 */
const tabForPath = (pathname: string): TabKey | null => {
  for (const tab of TABS) {
    if (pathname === tab.path || pathname.startsWith(`${tab.path}/`)) return tab.key
  }
  return null
}

export { TABS, tabForPath }
export type { TabKey, TabSpec }
