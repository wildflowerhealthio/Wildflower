import { useMemo, type JSX, type PropsWithChildren } from 'react'

import { makeAuthenticatedSession } from './client.ts'
import { AuthenticatedGatekeeperClientContext } from './gatekeeper-client-context.ts'

type AuthenticatedGatekeeperClientProviderProps = PropsWithChildren<{
  /**
   * Bearer token for the authenticated session. The session is
   * memoised on `token`, so a new token boots a fresh runtime +
   * client (the previous one is dropped on the next render).
   */
  readonly token: string
}>

/**
 * Wraps children with an authenticated `AuthenticatedSession` for
 * `useGatekeeperClient()`. Use behind `<GatekeeperAuthorizedRoutes>` (or
 * any other component that decides when a token is available); this
 * provider does **not** itself check whether a token exists.
 */
const AuthenticatedGatekeeperClientProvider = ({
  token,
  children,
}: AuthenticatedGatekeeperClientProviderProps): JSX.Element => {
  const session = useMemo(() => makeAuthenticatedSession(token), [token])
  return (
    <AuthenticatedGatekeeperClientContext.Provider value={session}>
      {children}
    </AuthenticatedGatekeeperClientContext.Provider>
  )
}

export { AuthenticatedGatekeeperClientProvider }
export type { AuthenticatedGatekeeperClientProviderProps }
