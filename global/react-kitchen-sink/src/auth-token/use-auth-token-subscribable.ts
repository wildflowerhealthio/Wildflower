import type { Subscribable } from 'effect'
import { useContext } from 'react'

import type { AuthSignal } from './auth-signal.ts'
import { AuthTokenContext } from './auth-token-context.ts'

/**
 * Returns the auth-readiness `Subscribable<AuthSignal>` from the
 * nearest `<AuthTokenProvider>`'s store. Throws when no provider is
 * in the tree.
 *
 * Use this when you need the Subscribable itself — e.g. to drive the
 * auth-ready gate or the token-rotation cache invalidator. It carries
 * the auth-readiness *signal* (web: an `AuthedUntil(exp)` derived from
 * the readable expiry cookie; embedded: a host-pushed `HostAuthed`),
 * never the credential itself.
 */
const useAuthTokenSubscribable = (): Subscribable.Subscribable<AuthSignal> => {
  const store = useContext(AuthTokenContext)
  if (store === null) {
    throw new Error('useAuthTokenSubscribable must be used inside <AuthTokenProvider>')
  }
  return store.subscribable
}

export { useAuthTokenSubscribable }
