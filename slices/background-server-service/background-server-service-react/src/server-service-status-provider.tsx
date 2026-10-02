import type { JSX, ReactNode } from 'react'

import {
  ServerServiceStatusContext,
  type ServerServiceStatusStore,
} from './server-service-status-store.ts'

interface ServerServiceStatusProviderProps {
  readonly store: ServerServiceStatusStore
  readonly children: ReactNode
}

/**
 * Provide the {@link ServerServiceStatusStore} to descendants. The app wraps
 * its router tree in this, so the banner, the `/settings/server` page and the
 * bridge handler writing the store share one.
 */
const ServerServiceStatusProvider = ({
  store,
  children,
}: ServerServiceStatusProviderProps): JSX.Element => (
  <ServerServiceStatusContext.Provider value={store}>
    {children}
  </ServerServiceStatusContext.Provider>
)

export { ServerServiceStatusProvider }
export type { ServerServiceStatusProviderProps }
