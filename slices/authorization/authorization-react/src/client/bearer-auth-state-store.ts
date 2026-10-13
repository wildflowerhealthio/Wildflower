/**
 * {@link AuthStateStore} factory for a page that holds its credential as a
 * **bearer token in page memory**, beside the server that issued it. The
 * launcher (`apps/launcher/launcher-web`) is the page that does.
 *
 * The page runs cross-origin to its API server, so no host authenticates for
 * it: a sign-in's session — the server it signed in to and the token
 * response's `access_token` — is held here, and the transport wrapper in
 * `apps/launcher/launcher-web` reads both to address and authenticate every
 * API request. A page reload returns to `Unauthed`: the bearer is in memory
 * only, no `localStorage`, which is the policy
 * `slices/authorization/docs/Auth Token Storage Explanation.md` sets for a
 * credential a public page holds. The server, which is no credential, is kept
 * in the storage the page passes (the tab's `sessionStorage`), so a reload, or
 * the expiry bounce back to the landing, still knows where to sign back in.
 *
 * The store satisfies {@link AuthStateStore} so every consumer is
 * environment-blind; the {@link BearerAuthStateStore.serverUrl} and
 * {@link BearerAuthStateStore.bearer} readers and the
 * {@link BearerAuthStateStore.writeSession} writer are the extra surface the
 * entry and transport wrapper use.
 */

import {
  type AuthState,
  type AuthStateStore,
  makeSubscribableStore,
  Unauthed,
} from '@wildflowerhealthio/react-kitchen-sink'
import { Equal } from 'effect'

/** A sign-in's session: the server the page signed in to, and the bearer it issued. */
interface BearerSession {
  readonly serverUrl: string
  readonly bearer: string
}

interface BearerAuthStateStore extends AuthStateStore {
  /**
   * The server this tab last signed in to, or `undefined` before any sign-in
   * in it. Kept across a reload and across the session lapsing, so a lapsed
   * session signs back in to the same server. Read by the transport wrapper,
   * which addresses every relative request to it.
   */
  readonly serverUrl: () => string | undefined
  /**
   * The current bearer token, or `undefined` when unauthed. Read by the
   * transport wrapper to attach `Authorization: Bearer <token>`.
   */
  readonly bearer: () => string | undefined
  /**
   * Hold `session` as this page's session: its server and its bearer, written
   * together. The only way either enters the store, and it publishes nothing:
   * the auth signal is the caller's to set, because only the caller knows what
   * the token response reported. Both callers follow it with `setAuthState` —
   * the device flow with `AuthedUntil({ exp })` from `expires_in`, the
   * redirect flow with whatever `authStateForSession` makes of a response that
   * may report no lifetime at all. A writer that published `AuthedUntil`
   * itself would have to invent an `exp` in that second case.
   */
  readonly writeSession: (session: BearerSession) => void
}

/**
 * Build the store, keeping the session's server in `storage` under
 * `serverUrlKey` and its bearer in page memory.
 */
const makeBearerAuthStateStore = (
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  serverUrlKey: string
): BearerAuthStateStore => {
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
    serverUrl: () => storage.getItem(serverUrlKey) ?? undefined,
    bearer: () => currentBearer,
    writeSession: ({ serverUrl, bearer }) => {
      storage.setItem(serverUrlKey, serverUrl)
      currentBearer = bearer
    },
  }
}

export { makeBearerAuthStateStore }
export type { BearerAuthStateStore, BearerSession }
