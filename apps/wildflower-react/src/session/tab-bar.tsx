import { Link } from '@tanstack/react-router'
import type { JSX, ReactNode } from 'react'

import { usePlatformTabs } from './platform-tabs-context.ts'
import { COLLECTOR_TAB, HOME_TAB, SETTINGS_TAB } from './tabs.ts'
import styles from './tab-bar.module.css'

/**
 * Primary navigation bar — the web counterpart of the Expo app's former
 * native tab bar. Renders Home and Collector, then any entry-contributed
 * platform tabs (see {@link usePlatformTabs}), then Settings; TanStack marks
 * the link for the current route (exact or descendant) as active, so the
 * accent styling and the built-in `aria-current="page"` track the location
 * without any local state.
 */
function TabBar(): JSX.Element {
  const platformTabs = usePlatformTabs()
  return (
    <nav className={styles['tab-bar']} aria-label="Primary">
      {[HOME_TAB, COLLECTOR_TAB, ...platformTabs, SETTINGS_TAB].map((tab) => (
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
