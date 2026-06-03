import type { Subscribable } from 'effect'
import { useContext } from 'react'

import { AuthTokenContext } from './auth-token-context.ts'

/**
 * Returns the auth-token `Subscribable<string | null>` from the
 * nearest `<AuthTokenProvider>`'s store. Throws when no provider is
 * in the tree.
 *
 * Use this when you need the Subscribable itself — e.g. inside a
 * per-slice runner hook that builds `Layer.succeed(BearerToken, subscribable)`
 * to feed into an Effect's layer composition.
 */
const useAuthTokenSubscribable = (): Subscribable.Subscribable<string | null> => {
  const store = useContext(AuthTokenContext)
  if (store === null) {
    throw new Error('useAuthTokenSubscribable must be used inside <AuthTokenProvider>')
  }
  return store.subscribable
}

export { useAuthTokenSubscribable }
