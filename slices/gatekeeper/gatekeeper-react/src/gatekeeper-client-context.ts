import { createContext } from 'react'

import type { AuthenticatedSession } from './client.ts'

/** Authenticated session context; provided by `<AuthenticatedGatekeeperClientProvider>`. */
const AuthenticatedGatekeeperClientContext = createContext<AuthenticatedSession | null>(null)

export { AuthenticatedGatekeeperClientContext }
