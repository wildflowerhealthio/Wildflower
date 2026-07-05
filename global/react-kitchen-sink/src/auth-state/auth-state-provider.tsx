import type { JSX, ReactNode } from 'react'

import { AuthStateContext } from './auth-state-context.ts'
import type { AuthStateStore } from './auth-state-store.ts'

interface AuthStateProviderProps {
  /**
   * The {@link AuthStateStore} that descendants will read from and
   * write through. Whoever owns the source of truth for the auth
   * token constructs an environment-specific store and passes it in.
   */
  readonly store: AuthStateStore
  readonly children: ReactNode
}

/**
 * Provides the {@link AuthStateStore} to descendants. Consumers read
 * via {@link useAuthStateSubscribable} when they need the Subscribable
 * itself (e.g. to feed a bearer-token Layer inside a hook), and write
 * via {@link useAuthStateSetter} when they need to rotate the token.
 */
const AuthStateProvider = ({ store, children }: AuthStateProviderProps): JSX.Element => (
  <AuthStateContext.Provider value={store}>{children}</AuthStateContext.Provider>
)

export { AuthStateProvider }
export type { AuthStateProviderProps }
