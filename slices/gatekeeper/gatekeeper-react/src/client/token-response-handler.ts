/**
 * Optional post-token-exchange hook for entries that hold the bearer
 * in page memory (the hosted entry). `NeedsAuthMessage` checks this
 * context after a successful device-flow token exchange; when provided,
 * it writes the bearer and does a client-side navigation instead of a
 * full-page reload.
 *
 * The Tauri entry holds no credential (the host authenticates its
 * direct-loopback requests by connection provenance), so it does not
 * wrap the tree in this provider; the context reads `undefined` and
 * `NeedsAuthMessage` falls back to a full-page `window.location.assign`.
 */

import { createContext, useContext } from 'react'

interface TokenResponseHandler {
  /**
   * Store the bearer from a successful token exchange. Called before
   * `setAuthState` so the transport can attach it on the next request.
   */
  readonly writeBearer: (accessToken: string) => void
  /**
   * Client-side navigation to `returnTo` after sign-in. Called instead
   * of `window.location.assign` so an in-memory bearer survives (a
   * full reload would lose it).
   */
  readonly navigateAfterAuth: (returnTo: string) => void
}

const TokenResponseHandlerContext = createContext<TokenResponseHandler | undefined>(undefined)

const useTokenResponseHandler = (): TokenResponseHandler | undefined =>
  useContext(TokenResponseHandlerContext)

export { TokenResponseHandlerContext, useTokenResponseHandler }
export type { TokenResponseHandler }
