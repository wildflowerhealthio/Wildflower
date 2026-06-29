/**
 * Per-entry {@link AuthTokenStore} factories for the gatekeeper auth
 * signal: {@link makeWebAuthTokenStore} (cookie-driven, for the
 * standalone web entries) and {@link makeEmbeddedAuthTokenStore}
 * (in-memory only, for the in-WebView SPA). Both return the same
 * {@link AuthTokenStore} shape so every consumer is environment-blind;
 * only the `main-*` entrypoint picks a factory.
 *
 * On the **web path** the real access token is the `HttpOnly` `wf_auth`
 * cookie the server sets at token issuance (#218) — invisible to JS, sent
 * automatically on every request. So the web store no longer *holds* the
 * token: it derives an "authed until `exp`" signal from the readable
 * companion cookie `wf_auth_exp` (carrying just the non-secret unix `exp`).
 * The signal is a `string | null` only so existing consumers
 * (`useAuthTokenSubscribable`, the auth-ready gate, the rotation
 * invalidator) keep working unchanged — its value is the `exp` string, not
 * a usable bearer, and the web runtime deliberately feeds `BearerToken` a
 * separate always-`null` source so no `Authorization` header is ever set.
 *
 * The **embedded WebView** keeps holding the raw JWT in memory and
 * attaching it as a header — `tauri://` fetches loopback cross-origin where
 * cookies don't travel cleanly (#218 point 8) — so
 * {@link makeEmbeddedAuthTokenStore} is unchanged.
 *
 * See `slices/gatekeeper/docs/Auth Token Storage Explanation.md` for the
 * storage-policy rationale.
 */

import { makeSubscribableStore, type AuthTokenStore } from 'react-kitchen-sink'

/**
 * Name of the readable companion cookie the server sets alongside the
 * `HttpOnly` `wf_auth` JWT (gatekeeper-rust `http/cookies.rs`). It carries
 * just the token's unix `exp` so JS can derive auth state without ever
 * holding the secret token.
 */
const AUTH_EXP_COOKIE_NAME = 'wf_auth_exp'

/** `setTimeout` clamps to a 32-bit delay; cap the expiry timer at it. */
const MAX_TIMER_DELAY = 2_147_483_647

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
 * Derive the web auth signal from the `wf_auth_exp` cookie: the non-secret
 * unix-`exp` string while it's still in the future, else `null`. JS never
 * sees the real JWT (the `HttpOnly` `wf_auth`); this is only a
 * presence/expiry hint. Exported for tests.
 */
const readAuthedSignalFromCookie = (): string | null => {
  const exp = readCookie(AUTH_EXP_COOKIE_NAME)
  if (exp === null || exp === '') return null
  const expMs = Number(exp) * 1000
  if (!Number.isFinite(expMs) || expMs <= Date.now()) return null
  return exp
}

/**
 * Build the standalone-web {@link AuthTokenStore}. The `subscribable` tracks
 * the cookie-derived "authed until `exp`" signal; it re-derives when the tab
 * regains focus/visibility (cookies don't fire `'storage'`, so this is how a
 * sign-in or logout in another tab surfaces) and flips to `null` via a timer
 * armed at `exp`. `setToken` ignores its argument — JS can't write the
 * `HttpOnly` `wf_auth`; the server already did via `Set-Cookie` on the
 * device-flow / refresh response — and just re-derives the signal from the
 * cookie, which is what `NeedsAuthMessage` triggers on sign-in completion.
 * Clearing the real session is a server action (`POST /access/logout`), not a
 * `setToken(null)`. Call once per page load in the `main-*` entrypoint.
 */
const makeWebAuthTokenStore = (): AuthTokenStore => {
  let current = readAuthedSignalFromCookie()
  const { subscribable, set } = makeSubscribableStore<string | null>(current)

  let expiryTimer: ReturnType<typeof setTimeout> | undefined

  const refresh = (): void => {
    const next = readAuthedSignalFromCookie()
    // Only publish on a real change so a focus/visibility tick on an
    // unchanged cookie doesn't churn the rotation invalidator.
    if (next !== current) {
      current = next
      set(next)
    }
    if (expiryTimer !== undefined) {
      clearTimeout(expiryTimer)
      expiryTimer = undefined
    }
    // Arm a timer to flip the signal to `null` the moment the hint expires,
    // so the UI reflects expiry without waiting for a navigation.
    if (next !== null && typeof setTimeout !== 'undefined') {
      const delay = Math.max(0, Number(next) * 1000 - Date.now())
      expiryTimer = setTimeout(refresh, Math.min(delay, MAX_TIMER_DELAY))
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('focus', refresh)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', refresh)
  }
  // Arm the initial expiry timer for an already-authed load (no `set`, so the
  // invalidator's replayed-initial skip still holds).
  if (current !== null && typeof setTimeout !== 'undefined') {
    const delay = Math.max(0, Number(current) * 1000 - Date.now())
    expiryTimer = setTimeout(refresh, Math.min(delay, MAX_TIMER_DELAY))
  }

  return {
    subscribable,
    setToken: () => {
      refresh()
    },
  }
}

/**
 * Build the embedded-WebView {@link AuthTokenStore}: a
 * `SubscriptionRef<string | null>` seeded with `null`, no persistence
 * subscriber, no cross-tab listener. The host's `AuthTokenIssued` handler
 * is the sole writer, and the held JWT is attached as an `Authorization`
 * header by the embedded HTTP client (cookies don't travel cleanly from
 * `tauri://` to the loopback origin — #218 point 8).
 *
 * Used by `main-embedded` / `main-tauri`; see the Auth Token Storage
 * Explanation for why this store ignores `localStorage`.
 */
const makeEmbeddedAuthTokenStore = (): AuthTokenStore => {
  const { subscribable, set: setToken } = makeSubscribableStore<string | null>(null)
  return { subscribable, setToken }
}

export {
  AUTH_EXP_COOKIE_NAME,
  makeEmbeddedAuthTokenStore,
  makeWebAuthTokenStore,
  readAuthedSignalFromCookie,
}
