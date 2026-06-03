import type { JSX, ReactNode } from 'react'

import { AuthTokenContext } from './auth-token-context.ts'
import type { AuthTokenStore } from './auth-token-store.ts'

interface AuthTokenProviderProps {
  /**
   * The {@link AuthTokenStore} that descendants will read from and
   * write through. Whoever owns the source of truth for the auth
   * token constructs this and passes it in — `gatekeeper-react`
   * provides `makeWebAuthTokenStore` / `makeEmbeddedAuthTokenStore`
   * factories per entrypoint.
   */
  readonly store: AuthTokenStore
  readonly children: ReactNode
}

/**
 * Provides the {@link AuthTokenStore} to descendants. Slice screens
 * read via {@link useAuthTokenSubscribable} when they need the
 * Subscribable itself (e.g. to feed into
 * `Layer.succeed(BearerToken, _)` inside a hook), and write via
 * {@link useAuthTokenSetter} when they need to rotate the token
 * (e.g. device-login completion, the page-bridge `AuthTokenIssued`
 * handler).
 */
const AuthTokenProvider = ({ store, children }: AuthTokenProviderProps): JSX.Element => (
  <AuthTokenContext.Provider value={store}>{children}</AuthTokenContext.Provider>
)

export { AuthTokenProvider }
export type { AuthTokenProviderProps }
