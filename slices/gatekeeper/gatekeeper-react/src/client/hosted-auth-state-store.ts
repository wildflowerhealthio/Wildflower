/**
 * Per-entry {@link AuthStateStore} factory for the hosted web entry
 * (`main-hosted`), where the bearer token lives in page memory —
 * not in a cookie or a host-side jar.
 *
 * The hosted page runs cross-origin to its API server, so the `HttpOnly`
 * `wf_auth` cookie (set `SameSite=Lax`) is never carried by its fetches.
 * Instead the device-flow token response's `access_token` is held here
 * and attached as an `Authorization` header by the transport wrapper in
 * `apps/wildflower-react`. A page reload returns to `Unauthed` (the
 * bearer is in-memory only; no `localStorage`, no cookie).
 *
 * The store satisfies {@link AuthStateStore} so every consumer is
 * environment-blind; the {@link HostedAuthStateStore.bearer} reader and
 * the {@link HostedAuthStateStore.writeBearer} writer are the extra surface the
 * hosted entry and transport wrapper use.
 */

import { Equal } from 'effect'
import {
  AuthedUntil,
  type AuthState,
  type AuthStateStore,
  makeSubscribableStore,
  Unauthed,
} from 'react-kitchen-sink'

interface HostedAuthStateStore extends AuthStateStore {
  /**
   * The current bearer token, or `undefined` when unauthed. Read by the
   * transport wrapper to attach `Authorization: Bearer <token>`.
   */
  readonly bearer: () => string | undefined
  /**
   * Store a bearer token from a device-flow token response and publish
   * `AuthedUntil({ exp })`. The only way the bearer enters the store.
   */
  readonly writeBearer: (token: string, exp: number) => void
  /**
   * Store a bearer token without publishing an auth signal. Used by the
   * `TokenResponseHandler` when `NeedsAuthMessage` will call
   * `setAuthState` separately right after.
   */
  readonly storeBearer: (token: string) => void
}

const makeHostedAuthStateStore = (): HostedAuthStateStore => {
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
    writeBearer: (token, exp) => {
      currentBearer = token
      publish(AuthedUntil({ exp }))
    },
    storeBearer: (token) => {
      currentBearer = token
    },
  }
}

export { makeHostedAuthStateStore }
export type { HostedAuthStateStore }
