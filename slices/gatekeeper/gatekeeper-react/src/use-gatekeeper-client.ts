import { useContext } from 'react'

import type { AuthenticatedSession } from './client.ts'
import { AuthenticatedGatekeeperClientContext } from './gatekeeper-client-context.ts'

/**
 * Returns the current authenticated gatekeeper session. Throws if used
 * outside `<AuthenticatedGatekeeperClientProvider>`.
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
