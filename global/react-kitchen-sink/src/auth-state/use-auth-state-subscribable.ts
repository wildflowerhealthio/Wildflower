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
 * the auth-readiness *signal* (web: an `AuthedUntil(exp)` derived from
 * the readable expiry cookie; embedded: a host-pushed `HostAuthed`),
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
