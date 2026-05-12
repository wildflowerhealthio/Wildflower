import type { Subscribable } from 'effect'
import { createContext } from 'react'

/**
 * React context carrying the live `Subscribable<string | null>` for
 * the bearer token. Apps wire it via `<AuthTokenProvider>` with a
 * slice-supplied subscribable (typically gatekeeper-react's
 * module-scoped `authTokenRef`, which bidirectionally syncs with
 * localStorage).
 */
const AuthTokenContext = createContext<Subscribable.Subscribable<string | null> | null>(null)

export { AuthTokenContext }
