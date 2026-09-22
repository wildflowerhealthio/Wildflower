/**
 * Per-entry {@link AuthStateStore} factories for the gatekeeper auth
 * signal: {@link makeCookieAuthStateStore} (cookie-driven, for an entry served
 * same-origin by the API server) and {@link makeEmbeddedAuthStateStore}
 * (in-memory only, for the in-WebView SPA). A third,
 * {@link makeBearerAuthStateStore}, lives in `bearer-auth-state-store.ts` for
 * an entry that runs cross-origin and must carry its own header. All three
 * return the same {@link AuthStateStore} shape so every consumer is
 * environment-blind; only the `main-*` entrypoint picks a factory.
 *
 * The factories are named for the **mechanism** — how the credential travels —
 * rather than for a deployment, because that is what actually decides which one
 * an entry can use.
 *
 * The store publishes a typed {@link AuthState}, never a credential:
 *
 * - On the **web path** the real access token is the `HttpOnly` `wf_auth`
 *   cookie the server sets at token issuance (#218) — invisible to JS. So the
 *   web store derives `AuthedUntil(exp)` from the readable companion cookie
 *   `wf_auth_exp` (just the non-secret unix `exp`), or `Unauthed` when it's
 *   absent/expired. HTTP clients stay tokenless — the cookie authenticates
 *   same-origin requests on its own.
 * - The **embedded WebView** holds no credential either: the host plants the
 *   `wf_auth` cookie in the webview's jar and pushes a contentless notify, which
 *   the bridge turns into `HostAuthed`.
 *
 * See `slices/gatekeeper/docs/Auth Token Storage Explanation.md` for the
 * storage-policy rationale.
 */

import { Equal } from 'effect'
import {
  AuthedUntil,
  type AuthState,
  type AuthStateStore,
  makeSubscribableStore,
  Unauthed,
} from 'react-kitchen-sink'

/**
 * Name of the readable companion cookie the server sets alongside the
 * `HttpOnly` `wf_auth` JWT (gatekeeper-rust `http/cookies.rs`). It carries
 * just the token's unix `exp` so JS can derive auth state without ever
 * holding the secret token.
 */
const AUTH_EXP_COOKIE_NAME = 'wf_auth_exp'

/** Read a cookie value from `document.cookie`, or `null` if absent. */
const readCookie = (name: string): string | null => {
  if (typeof document === 'undefined') return null
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

/**
 * Derive the web {@link AuthState} from the `wf_auth_exp` cookie:
 * `AuthedUntil(exp)` while the non-secret unix `exp` is still in the future,
 * else `Unauthed`. JS never sees the real JWT (the `HttpOnly` `wf_auth`); this
 * is only a presence/expiry hint. Exported for tests.
 */
const readAuthedSignalFromCookie = (): AuthState => {
  const exp = readCookie(AUTH_EXP_COOKIE_NAME)
  if (exp === null || exp === '') return Unauthed()
  const expNum = Number(exp)
  if (!Number.isFinite(expNum) || expNum * 1000 <= Date.now()) return Unauthed()
  return AuthedUntil({ exp: expNum })
}

/**
 * Build the standalone-web {@link AuthStateStore}. The `subscribable` tracks
 * the cookie-derived signal; it re-derives when the tab regains focus (cookies
 * don't fire `'storage'`, so this is how a sign-in or logout in another tab
 * surfaces). `setAuthState` ignores its argument — JS can't write the `HttpOnly`
 * `wf_auth`; the server already did via `Set-Cookie` on the device-flow /
 * refresh response — and just re-derives the signal from the cookie, which is
 * what `NeedsAuthMessage` triggers on sign-in completion. Clearing the real
 * session is a server action (`POST /access/logout`).
 *
 * No proactive expiry timer: an `AuthedUntil(exp)` whose `exp` has passed is
 * re-derived to `Unauthed` on the next focus (or the next authed request, which
 * 401s and drives the device-login redirect). Consumers wanting sub-focus
 * freshness can read `exp` off the signal themselves. Call once per page load in
 * the `main-*` entrypoint.
 */
const makeCookieAuthStateStore = (): AuthStateStore => {
  let current = readAuthedSignalFromCookie()
  const { subscribable, set } = makeSubscribableStore<AuthState>(current)

  const refresh = (): void => {
    const next = readAuthedSignalFromCookie()
    // Publish only on a real change so a focus tick on an unchanged cookie
    // doesn't churn the rotation invalidator. `AuthState` is a `Data` tagged
    // enum, so structural `Equal.equals` compares tag + `exp`.
    if (!Equal.equals(next, current)) {
      current = next
      set(next)
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('focus', refresh)
  }

  return {
    subscribable,
    setAuthState: () => {
      refresh()
    },
  }
}

/**
 * Build the Tauri {@link AuthStateStore}: a `SubscriptionRef<AuthState>`
 * seeded `Unauthed`, no persistence subscriber, no cross-tab listener. The
 * host's `AuthTokenIssued` bridge handler is the sole writer (it publishes
 * `HostAuthed`); the value drives the auth-readiness signal (the `beforeLoad`
 * gate + the rotation invalidator). HTTP clients are tokenless — Tauri
 * authenticates its loopback fetches via the `wf_auth` cookie the host syncs
 * into the webview's cookie jar (`tauri://` JS can't manage that cookie itself).
 *
 * Used by `main-tauri`; see the Auth Token Storage Explanation.
 */
const makeEmbeddedAuthStateStore = (): AuthStateStore => {
  const { subscribable, set: setAuthState } = makeSubscribableStore<AuthState>(Unauthed())
  return { subscribable, setAuthState }
}

export {
  AUTH_EXP_COOKIE_NAME,
  makeCookieAuthStateStore,
  makeEmbeddedAuthStateStore,
  readAuthedSignalFromCookie,
}
