import { useMemo, type JSX, type PropsWithChildren } from 'react'

import { makeAuthenticatedSession } from './client.ts'
import { AuthenticatedGatekeeperClientContext } from './gatekeeper-client-context.ts'

type AuthenticatedGatekeeperClientProviderProps = PropsWithChildren<{
  /** Bearer token; the session is memoised on `token`, so rotation boots a fresh runtime. */
  readonly token: string
}>

/**
 * Provides an authenticated session for {@link useGatekeeperClient}. The
 * caller must check whether a token is available before mounting.
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
