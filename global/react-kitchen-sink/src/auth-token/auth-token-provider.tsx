import type { JSX, ReactNode } from 'react'

import { AuthTokenContext } from './auth-token-context.ts'
import type { AuthTokenStore } from './auth-token-store.ts'

interface AuthTokenProviderProps {
  /**
   * The {@link AuthTokenStore} that descendants will read from and
   * write through. Whoever owns the source of truth for the auth
   * token constructs an environment-specific store and passes it in.
   */
  readonly store: AuthTokenStore
  readonly children: ReactNode
}

/**
 * Provides the {@link AuthTokenStore} to descendants. Consumers read
 * via {@link useAuthTokenSubscribable} when they need the Subscribable
 * itself (e.g. to feed a bearer-token Layer inside a hook), and write
 * via {@link useAuthTokenSetter} when they need to rotate the token.
 */
const AuthTokenProvider = ({ store, children }: AuthTokenProviderProps): JSX.Element => (
  <AuthTokenContext.Provider value={store}>{children}</AuthTokenContext.Provider>
)

export { AuthTokenProvider }
export type { AuthTokenProviderProps }
