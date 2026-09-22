/**
 * {@link AuthStateStore} factory for an entry that holds its credential as a
 * **bearer token in page memory** — not in a cookie or a host-side jar. The
 * `main-web` entry of `apps/wildflower-react` is the one that does.
 *
 * Named for the mechanism rather than the deployment, alongside
 * {@link makeCookieAuthStateStore}: which one an entry picks is decided by how
 * its credential travels, and a page that runs cross-origin to its API server
 * has no choice. The `HttpOnly` `wf_auth` cookie is set `SameSite=Lax`, so it
 * is never carried by a cross-origin fetch; the token response's
 * `access_token` is held here instead and attached as an `Authorization`
 * header by the transport wrapper in `apps/wildflower-react`. A page reload
 * returns to `Unauthed` — the bearer is in memory only, no `localStorage` and
 * no cookie, which is the policy
 * `slices/gatekeeper/docs/Auth Token Storage Explanation.md` sets for a
 * credential a public page holds.
 *
 * The store satisfies {@link AuthStateStore} so every consumer is
 * environment-blind; the {@link BearerAuthStateStore.bearer} reader and
 * the {@link BearerAuthStateStore.writeBearer} writer are the extra surface the
 * entry and transport wrapper use.
 */

import { Equal } from 'effect'
import {
  type AuthState,
  type AuthStateStore,
  makeSubscribableStore,
  Unauthed,
} from 'react-kitchen-sink'

interface BearerAuthStateStore extends AuthStateStore {
  /**
   * The current bearer token, or `undefined` when unauthed. Read by the
   * transport wrapper to attach `Authorization: Bearer <token>`.
   */
  readonly bearer: () => string | undefined
  /**
   * Hold `token` as this page's bearer. The only way the bearer enters the
   * store, and it publishes nothing: the auth signal is the caller's to set,
   * because only the caller knows what the token response reported. Both
   * callers follow it with `setAuthState` — the device flow with
   * `AuthedUntil({ exp })` from `expires_in`, the redirect flow with whatever
   * `authStateForSession` makes of a response that may report no lifetime at
   * all. A writer that published `AuthedUntil` itself would have to invent an
   * `exp` in that second case.
   */
  readonly writeBearer: (token: string) => void
}

const makeBearerAuthStateStore = (): BearerAuthStateStore => {
  let currentBearer: string | undefined
  let current: AuthState = Unauthed()
  const { subscribable, set } = makeSubscribableStore<AuthState>(current)

  const publish = (next: AuthState): void => {
    if (!Equal.equals(next, current)) {
      current = next
      set(next)
    }
  }

  return {
    subscribable,
    setAuthState: (signal) => {
      if (signal._tag === 'Unauthed') {
        currentBearer = undefined
      }
      publish(signal)
    },
    bearer: () => currentBearer,
    writeBearer: (token) => {
      currentBearer = token
    },
  }
}

export { makeBearerAuthStateStore }
export type { BearerAuthStateStore }
