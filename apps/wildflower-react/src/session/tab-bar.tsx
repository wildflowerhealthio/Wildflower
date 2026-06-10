import { Link } from '@tanstack/react-router'
import type { JSX, ReactNode } from 'react'

import { TABS } from './tab-mapping.ts'
import styles from './tab-bar.module.css'

/**
 * Primary navigation bar — the web counterpart of the Expo app's native
 * tab bar. Renders one `<Link>` per {@link TABS} entry; TanStack marks
 * the link for the current route (exact or descendant) as active, so the
 * accent styling and `aria-current` track the location without any local
 * state or a `tabForPath` lookup.
 */
function TabBar(): JSX.Element {
  return (
    <nav className={styles['tabBar']} aria-label="Primary">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          to={tab.path}
          className={styles['tab']}
          activeProps={{ className: styles['tabActive'], 'aria-current': 'page' }}
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
 * phone-width viewports and above it at >=768px (see `tab-bar.module.css`).
 *
 * Mounted by the `_auth` and `/settings` layouts — the two route subtrees
 * the tabs point into — so it persists across tab switches but stays off
 * the public device-login screen.
 */
function AppTabShell({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className={styles['shell']}>
      <div className={styles['content']}>{children}</div>
      <TabBar />
    </div>
  )
}

export { AppTabShell, TabBar }
