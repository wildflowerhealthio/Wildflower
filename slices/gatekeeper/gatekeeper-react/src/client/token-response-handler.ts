/**
 * The post-token-exchange hook `NeedsAuthMessage` calls after a successful
 * device-flow token exchange: the page holds its bearer in page memory, so
 * the hook writes it and navigates client-side, where a full-page reload
 * would lose it. The launcher provides it around its whole tree.
 */

import { useContextOrThrow } from '@wildflowerhealthio/react-kitchen-sink'
import { createContext } from 'react'

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

const TokenResponseHandlerContext = createContext<TokenResponseHandler | null>(null)
TokenResponseHandlerContext.displayName = 'TokenResponseHandlerContext'

/**
 * The page's {@link TokenResponseHandler}.
 *
 * @throws `NoContextException` if no `<TokenResponseHandlerContext>` mounts above.
 */
const useTokenResponseHandler = (): TokenResponseHandler =>
  useContextOrThrow(TokenResponseHandlerContext)

export { TokenResponseHandlerContext, useTokenResponseHandler }
export type { TokenResponseHandler }
