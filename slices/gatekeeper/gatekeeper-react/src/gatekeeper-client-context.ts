import { createContext } from 'react'

import type { GatekeeperClient } from './client/gatekeeper-client.ts'

/**
 * React context carrying a {@link GatekeeperClient}.
 *
 * Provided by `<GatekeeperClientProvider>` — the app wraps the whole tree
 * with `token={null}` (so public routes can call OAuth/device endpoints),
 * and the `<AuthorizedAppShell>` re-provides with the live token so
 * authenticated screens see a bearer-attached client through the same hook.
 */
const GatekeeperClientContext = createContext<GatekeeperClient | null>(null)

export { GatekeeperClientContext }
