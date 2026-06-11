/**
 * The three top-level surfaces the authed shell exposes. The order here
 * is a presentation concern (left-to-right in the bar).
 *
 * Each `path` is a real registered route, so TanStack's `<Link>` derives
 * the active tab itself (exact-or-descendant prefix match) — no separate
 * lookup helper is needed.
 */
type TabKey = 'home' | 'collector' | 'settings'

/** A single tab's identity, label, and destination route. */
interface TabSpec {
  readonly key: TabKey
  readonly label: string
  // A small literal union, kept by hand: the route-tree-derived
  // alternatives don't pay off here — `LinkProps['to']` widens to `any`
  // (an unsafe-assignment at the `<Link to>` call site) and `RoutePaths`
  // isn't re-exported from `@tanstack/react-router`. With three rarely
  // changing top-level surfaces, the literal union is the safe choice.
  readonly path: '/home' | '/collector' | '/settings'
}

const TABS: ReadonlyArray<TabSpec> = [
  { key: 'home', label: 'Home', path: '/home' },
  { key: 'collector', label: 'Collector', path: '/collector' },
  { key: 'settings', label: 'Settings', path: '/settings' },
]

export { TABS }
export type { TabKey, TabSpec }
