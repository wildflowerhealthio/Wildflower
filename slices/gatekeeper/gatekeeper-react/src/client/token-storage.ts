/**
 * Per-entry {@link AuthTokenStore} factories for the gatekeeper auth
 * signal: {@link makeWebAuthTokenStore} (cookie-driven, for the
 * standalone web entries) and {@link makeEmbeddedAuthTokenStore}
 * (in-memory only, for the in-WebView SPA). Both return the same
 * {@link AuthTokenStore} shape so every consumer is environment-blind;
 * only the `main-*` entrypoint picks a factory.
 *
 * The store publishes a typed {@link AuthSignal}, never a credential:
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
  type AuthSignal,
  type AuthTokenStore,
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
 * Derive the web {@link AuthSignal} from the `wf_auth_exp` cookie:
 * `AuthedUntil(exp)` while the non-secret unix `exp` is still in the future,
 * else `Unauthed`. JS never sees the real JWT (the `HttpOnly` `wf_auth`); this
 * is only a presence/expiry hint. Exported for tests.
 */
const readAuthedSignalFromCookie = (): AuthSignal => {
  const exp = readCookie(AUTH_EXP_COOKIE_NAME)
  if (exp === null || exp === '') return Unauthed()
  const expNum = Number(exp)
  if (!Number.isFinite(expNum) || expNum * 1000 <= Date.now()) return Unauthed()
  return AuthedUntil({ exp: expNum })
}

/**
 * Build the standalone-web {@link AuthTokenStore}. The `subscribable` tracks
 * the cookie-derived signal; it re-derives when the tab regains focus (cookies
 * don't fire `'storage'`, so this is how a sign-in or logout in another tab
 * surfaces). `setSignal` ignores its argument — JS can't write the `HttpOnly`
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
const makeWebAuthTokenStore = (): AuthTokenStore => {
  let current = readAuthedSignalFromCookie()
  const { subscribable, set } = makeSubscribableStore<AuthSignal>(current)

  const refresh = (): void => {
    const next = readAuthedSignalFromCookie()
    // Publish only on a real change so a focus tick on an unchanged cookie
    // doesn't churn the rotation invalidator. `AuthSignal` is a `Data` tagged
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
    setSignal: () => {
      refresh()
    },
  }
}

/**
 * Build the Tauri {@link AuthTokenStore}: a `SubscriptionRef<AuthSignal>`
 * seeded `Unauthed`, no persistence subscriber, no cross-tab listener. The
 * host's `AuthTokenIssued` bridge handler is the sole writer (it publishes
 * `HostAuthed`); the value drives the auth-readiness signal (the `beforeLoad`
 * gate + the rotation invalidator). HTTP clients are tokenless — Tauri
 * authenticates its loopback fetches via the `wf_auth` cookie the host syncs
 * into the webview's cookie jar (`tauri://` JS can't manage that cookie itself).
 *
 * Used by `main-tauri`; see the Auth Token Storage Explanation.
 */
const makeEmbeddedAuthTokenStore = (): AuthTokenStore => {
  const { subscribable, set: setSignal } = makeSubscribableStore<AuthSignal>(Unauthed())
  return { subscribable, setSignal }
}

export {
  AUTH_EXP_COOKIE_NAME,
  makeEmbeddedAuthTokenStore,
  makeWebAuthTokenStore,
  readAuthedSignalFromCookie,
}
