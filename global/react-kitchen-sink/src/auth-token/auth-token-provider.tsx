import type { Subscribable } from 'effect'
import type { JSX, ReactNode } from 'react'

import { AuthTokenContext } from './auth-token-context.ts'

interface AuthTokenProviderProps {
  /**
   * The bearer-token subscribable. Typically gatekeeper-react's
   * module-scoped `authTokenRef`. Whoever owns the source of truth
   * for the auth token constructs this and passes it in.
   */
  readonly subscribable: Subscribable.Subscribable<string | null>
  readonly children: ReactNode
}

/**
 * Provides the auth-token Subscribable to descendants. Slice screens
 * read via {@link useAuthToken} for value-style access, or
 * {@link useAuthTokenSubscribable} when they need the Subscribable
 * itself (e.g. to feed into `bearerTokenLayer` inside a hook).
 */
const AuthTokenProvider = ({ subscribable, children }: AuthTokenProviderProps): JSX.Element => (
  <AuthTokenContext.Provider value={subscribable}>{children}</AuthTokenContext.Provider>
)

export { AuthTokenProvider }
export type { AuthTokenProviderProps }
