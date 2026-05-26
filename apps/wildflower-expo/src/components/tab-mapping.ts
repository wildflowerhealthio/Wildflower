type TabKey = 'apps' | 'collector' | 'settings'

interface TabSpec {
  readonly key: TabKey
  readonly label: string
  readonly path: string
}

/**
 * The three top-level surfaces the persistent shell exposes. Order
 * matters: `tabForPath` falls back to `TABS[0]` for unmapped paths,
 * which makes Apps the implicit "home" tab.
 */
const TABS: ReadonlyArray<TabSpec> = [
  { key: 'apps', label: 'Apps', path: '/apps' },
  { key: 'collector', label: 'Collector', path: '/collector' },
  { key: 'settings', label: 'Settings', path: '/settings' },
]

/**
 * Map an in-SPA pathname (emitted by `NavigationBridge.RouteChanged`)
 * to the tab that should appear active. A pathname matches a tab when
 * it equals the tab's path exactly OR is a descendant (prefix match
 * on `path/`). Unrecognized paths fall back to `TABS[0]`.
 */
const tabForPath = (pathname: string): TabKey => {
  for (const tab of TABS) {
    if (pathname === tab.path || pathname.startsWith(`${tab.path}/`)) return tab.key
  }
  return TABS[0].key
}

export { TABS, tabForPath }
export type { TabKey, TabSpec }
