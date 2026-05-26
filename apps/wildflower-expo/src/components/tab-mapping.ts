type TabKey = 'apps' | 'collector' | 'settings'

interface TabSpec {
  readonly key: TabKey
  readonly label: string
  readonly path: string
}

/**
 * The three top-level surfaces the persistent shell exposes. The order
 * here is a presentation concern (left-to-right in the tab bar); the
 * fallback tab is named separately via `FALLBACK_TAB_KEY`.
 */
const TABS: ReadonlyArray<TabSpec> = [
  { key: 'apps', label: 'Apps', path: '/apps' },
  { key: 'collector', label: 'Collector', path: '/collector' },
  { key: 'settings', label: 'Settings', path: '/settings' },
]

/**
 * The tab that should appear active for any pathname not under a known
 * tab root. Decoupled from `TABS`' order so reorderings stay safe.
 */
const FALLBACK_TAB_KEY: TabKey = 'apps'

/**
 * Map an in-SPA pathname (emitted by `NavigationBridge.RouteChanged`)
 * to the tab that should appear active. A pathname matches a tab when
 * it equals the tab's path exactly OR is a descendant (prefix match
 * on `path/`). Unrecognized paths fall back to `FALLBACK_TAB_KEY`.
 */
const tabForPath = (pathname: string): TabKey => {
  for (const tab of TABS) {
    if (pathname === tab.path || pathname.startsWith(`${tab.path}/`)) return tab.key
  }
  return FALLBACK_TAB_KEY
}

export { FALLBACK_TAB_KEY, TABS, tabForPath }
export type { TabKey, TabSpec }
