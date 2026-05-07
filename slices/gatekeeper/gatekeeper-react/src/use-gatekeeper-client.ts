import { useContext } from 'react'

import type { AuthenticatedSession } from './client.ts'
import { AuthenticatedGatekeeperClientContext } from './gatekeeper-client-context.ts'

/**
 * Returns the current authenticated gatekeeper session. Throws if
 * used outside `<AuthenticatedGatekeeperClientProvider>` — typically
 * placed via `<GatekeeperAuthorizedRoutes>` so screens don't have to
 * branch on whether a token is present.
 */
const useGatekeeperClient = (): AuthenticatedSession => {
  const session = useContext(AuthenticatedGatekeeperClientContext)
  if (session === null) {
    throw new Error(
      'useGatekeeperClient must be used inside <AuthenticatedGatekeeperClientProvider>'
    )
  }
  return session
}

export { useGatekeeperClient }
