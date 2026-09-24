import { Data } from 'effect'

/**
 * The auth-readiness signal an app's {@link AuthStateStore} publishes.
 *
 * A tagged sum type, so each platform mode is its own variant rather than an
 * overloaded sentinel value:
 *
 *  - `Unauthed` — no session.
 *  - `AuthedUntil({ exp })` — authed with a known unix-seconds expiry. A
 *    bearer-holding page publishes this from the token response's
 *    `expires_in`; a consumer that wants freshness can compare `exp` to now.
 *  - `HostAuthed` — authed via an external host/provenance with no token expiry
 *    known to the page (an embedded-webview path, where the host holds the
 *    credential and pushes a contentless "authed" notify).
 *
 * Generic auth-readiness infrastructure — no app-specific knowledge — so it
 * lives beside {@link AuthStateStore}.
 */
type AuthState = Data.TaggedEnum<{
  readonly Unauthed: Record<never, never>
  readonly AuthedUntil: { readonly exp: number }
  readonly HostAuthed: Record<never, never>
}>

const AuthState = Data.taggedEnum<AuthState>()
const { Unauthed, AuthedUntil, HostAuthed, $is } = AuthState

/** Whether the signal represents an authenticated session (any non-`Unauthed`). */
const isAuthed = (signal: AuthState): boolean => signal._tag !== 'Unauthed'

/**
 * Whether the session is still *fresh* at `nowSeconds` (unix seconds). Like
 * {@link isAuthed}, except an {@link AuthedUntil} whose `exp` has already passed
 * counts as not fresh: the page computes `exp` once at sign-in and nothing
 * re-derives it, so the server can already have expired the credential behind
 * it. A consumer that must not act on a lapsed session — e.g. gating an authed-only fetch that would otherwise 401 —
 * checks this instead of {@link isAuthed}. {@link HostAuthed} carries no
 * page-known expiry, so it is always fresh.
 */
const isFreshlyAuthed = (signal: AuthState, nowSeconds: number): boolean =>
  AuthState.$match(signal, {
    Unauthed: () => false,
    AuthedUntil: ({ exp }) => exp > nowSeconds,
    HostAuthed: () => true,
  })

export { type AuthState, Unauthed, AuthedUntil, HostAuthed, isAuthed, isFreshlyAuthed, $is }
