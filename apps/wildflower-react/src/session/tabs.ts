/**
 * The top-level surfaces the authed shell exposes. The order here is a
 * presentation concern (left-to-right in the bar).
 *
 * Each `path` is a real registered route, so TanStack's `<Link>` derives
 * the active tab itself (exact-or-descendant prefix match) — no separate
 * lookup helper is needed.
 *
 * `har-recorder` is named here but has no shared constant: it is a platform
 * tab the Tauri entry contributes through `platformTabs`, and one union should
 * still describe every tab a bar can render.
 */
type TabKey = 'home' | 'collector' | 'settings' | 'har-recorder'

/** A single tab's identity, label, and destination route. */
interface TabSpec {
  readonly key: TabKey
  readonly label: string
  // A small literal union, kept by hand: the route-tree-derived
  // alternatives don't pay off here — `LinkProps['to']` widens to `any`
  // (an unsafe-assignment at the `<Link to>` call site) and `RoutePaths`
  // isn't re-exported from `@tanstack/react-router`. With a handful of rarely
  // changing top-level surfaces, the literal union is the safe choice.
  readonly path: '/home' | '/collector' | '/settings' | '/har-recorder'
}

const HOME_TAB: TabSpec = { key: 'home', label: 'Home', path: '/home' }
const COLLECTOR_TAB: TabSpec = { key: 'collector', label: 'Collector', path: '/collector' }
const SETTINGS_TAB: TabSpec = { key: 'settings', label: 'Settings', path: '/settings' }

export { COLLECTOR_TAB, HOME_TAB, SETTINGS_TAB }
export type { TabKey, TabSpec }
