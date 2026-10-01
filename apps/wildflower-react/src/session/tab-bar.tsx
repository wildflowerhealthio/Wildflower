import { Link } from '@tanstack/react-router'
import type { JSX, ReactNode } from 'react'

import { usePlatformTabs } from './platform-tabs-context.ts'
import { ServerKind, useServerKind } from './server-kind.ts'
import {
  COLLECTOR_TAB,
  HOME_TAB,
  PLAIN_SMART_HOME_TAB,
  SETTINGS_TAB,
  type TabSpec,
} from './tabs.ts'
import styles from './tab-bar.module.css'

/**
 * The tabs the bar renders for `serverKind`: on a Wildflower server, Home and
 * Collector, then the entry's `platformTabs`, then Settings; on a plain SMART
 * server, only its Home, since every other surface calls Wildflower-only
 * endpoints.
 */
const tabsFor = (serverKind: ServerKind, platformTabs: readonly TabSpec[]): readonly TabSpec[] =>
  ServerKind.$match(serverKind, {
    Wildflower: () => [HOME_TAB, COLLECTOR_TAB, ...platformTabs, SETTINGS_TAB],
    PlainSmart: () => [PLAIN_SMART_HOME_TAB],
  })

/**
 * Primary navigation bar — the web counterpart of the Expo app's former
 * native tab bar. Renders the tabs for the tree's {@link ServerKind} (see
 * {@link tabsFor}), including any entry-contributed platform tabs (see
 * {@link usePlatformTabs}); TanStack marks the link for the current route
 * (exact or descendant) as active, so the accent styling and the built-in
 * `aria-current="page"` track the location without any local state.
 */
function TabBar(): JSX.Element {
  const platformTabs = usePlatformTabs()
  const serverKind = useServerKind()
  return (
    <nav className={styles['tab-bar']} aria-label="Primary">
      {tabsFor(serverKind, platformTabs).map((tab) => (
        <Link
          key={tab.key}
          to={tab.path}
          className={styles['tab']}
          activeProps={{ className: styles['tab--active'] }}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}

/**
 * Shell for the authed surfaces: a scrollable content column with the
 * persistent {@link TabBar}. The bar sits below the content on
 * phone-width viewports and above it at \>=768px (see `tab-bar.module.css`).
 *
 * Mounted by the `_auth` and `/settings` layouts — the two route subtrees
 * the tabs point into — so it persists across tab switches but stays off
 * the public device-login screen.
 */
function AppTabShell({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className={styles['tab-shell']}>
      <div className={styles['tab-shell__content']}>{children}</div>
      <TabBar />
    </div>
  )
}

export { AppTabShell, TabBar }
