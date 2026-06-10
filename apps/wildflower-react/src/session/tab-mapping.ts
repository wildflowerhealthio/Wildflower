/**
 * The three top-level surfaces the authed shell exposes, mirroring the
 * Expo app's native tab bar (`apps/wildflower-expo/.../tab-mapping.ts`).
 * The order here is a presentation concern (left-to-right in the bar).
 *
 * Each `path` is a real registered route, so TanStack's `<Link>` derives
 * the active tab itself (exact-or-descendant prefix match) — there's no
 * separate `tabForPath` lookup like the WebView host needed.
 */
type TabKey = 'home' | 'collector' | 'settings'

/** A single tab's identity, label, and destination route. */
interface TabSpec {
  readonly key: TabKey
  readonly label: string
  readonly path: '/home' | '/collector' | '/settings'
}

const TABS: ReadonlyArray<TabSpec> = [
  { key: 'home', label: 'Home', path: '/home' },
  { key: 'collector', label: 'Collector', path: '/collector' },
  { key: 'settings', label: 'Settings', path: '/settings' },
]

export { TABS }
export type { TabKey, TabSpec }
