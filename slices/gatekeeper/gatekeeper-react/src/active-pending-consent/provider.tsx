import type { JSX, ReactNode } from 'react'

import { ActivePendingConsentContext } from './context.ts'
import type { ActivePendingConsentStore } from './store.ts'

interface ActivePendingConsentProviderProps {
  readonly store: ActivePendingConsentStore
  readonly children: ReactNode
}

/**
 * Provide the {@link ActivePendingConsentStore} to descendants. The
 * app's `renderApp` wraps the router tree in this so the
 * {@link PendingConsentModalHost} (mounted alongside `<Outlet />`) and
 * the bridge handler share one store.
 */
const ActivePendingConsentProvider = ({
  store,
  children,
}: ActivePendingConsentProviderProps): JSX.Element => (
  <ActivePendingConsentContext.Provider value={store}>
    {children}
  </ActivePendingConsentContext.Provider>
)

export { ActivePendingConsentProvider }
export type { ActivePendingConsentProviderProps }
