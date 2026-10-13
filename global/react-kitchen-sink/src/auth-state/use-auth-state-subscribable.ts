import type { Subscribable } from 'effect'
import { useContext } from 'react'

import { AuthStateContext } from './auth-state-context.ts'
import type { AuthState } from './auth-state.ts'

/**
 * Returns the auth-readiness `Subscribable<AuthState>` from the
 * nearest `<AuthStateProvider>`'s store. Throws when no provider is
 * in the tree.
 *
 * Use this when you need the Subscribable itself — e.g. to drive the
 * auth-ready gate or the token-rotation cache invalidator. It carries
 * the auth-readiness *signal* (an `AuthedUntil(exp)` published at sign-in
 * from the token response, or `HostAuthed` when it reported no lifetime),
 * never the credential itself.
 */
const useAuthStateSubscribable = (): Subscribable.Subscribable<AuthState> => {
  const store = useContext(AuthStateContext)
  if (store === null) {
    throw new Error('useAuthStateSubscribable must be used inside <AuthStateProvider>')
  }
  return store.subscribable
}

export { useAuthStateSubscribable }
