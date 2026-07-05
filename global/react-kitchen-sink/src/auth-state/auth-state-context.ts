import { createContext } from 'react'

import type { AuthStateStore } from './auth-state-store.ts'

/**
 * React context carrying the {@link AuthStateStore} for the bearer
 * token. Apps wire it via `<AuthStateProvider>` with an
 * environment-specific store the app constructs.
 *
 * Both halves of the store ride one context so React-side consumers
 * never have to pair up two providers (one for read, one for write) —
 * a missing provider on either side would silently land in the wrong
 * code path; co-locating them makes the `useAuthStateSetter()` /
 * `useAuthStateSubscribable()` hooks impossible to half-wire.
 */
const AuthStateContext = createContext<AuthStateStore | null>(null)
AuthStateContext.displayName = 'AuthStateContext'

export { AuthStateContext }
