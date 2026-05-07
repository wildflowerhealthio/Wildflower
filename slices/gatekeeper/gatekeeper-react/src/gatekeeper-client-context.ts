import { createContext } from 'react'

import type { AuthenticatedSession } from './client.ts'

/**
 * The authenticated session is provided by
 * `<AuthenticatedGatekeeperClientProvider>`. Consumers of
 * `useGatekeeperClient()` always see a real session — the
 * unauthenticated case is handled one layer up (`<GatekeeperAuthorizedRoutes>`),
 * so screens don't have to branch on it.
 */
const AuthenticatedGatekeeperClientContext = createContext<AuthenticatedSession | null>(null)

export { AuthenticatedGatekeeperClientContext }
