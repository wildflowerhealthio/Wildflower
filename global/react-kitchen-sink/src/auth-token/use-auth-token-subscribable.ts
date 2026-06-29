import type { Subscribable } from 'effect'
import { useContext } from 'react'

import { AuthTokenContext } from './auth-token-context.ts'

/**
 * Returns the auth-token `Subscribable<string | null>` from the
 * nearest `<AuthTokenProvider>`'s store. Throws when no provider is
 * in the tree.
 *
 * Use this when you need the Subscribable itself — e.g. to drive the
 * auth-ready gate or the token-rotation cache invalidator. It carries
 * the auth-readiness *signal* (web: the `wf_auth_exp` cookie hint;
 * embedded: the host-pushed JWT), not a header injected into requests.
 */
const useAuthTokenSubscribable = (): Subscribable.Subscribable<string | null> => {
  const store = useContext(AuthTokenContext)
  if (store === null) {
    throw new Error('useAuthTokenSubscribable must be used inside <AuthTokenProvider>')
  }
  return store.subscribable
}

export { useAuthTokenSubscribable }
