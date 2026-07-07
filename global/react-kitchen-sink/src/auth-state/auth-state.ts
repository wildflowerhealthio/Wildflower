import { Data } from 'effect'

/**
 * The auth-readiness signal an app's {@link AuthStateStore} publishes.
 *
 * A tagged sum type so the platform modes are unrepresentable-wrong — unlike the
 * `string | null` it replaces, which overloaded one value with three
 * platform-dependent meanings (a `wf_auth_exp` digit string, a literal host
 * sentinel, and `null`):
 *
 *  - `Unauthed` — no session.
 *  - `AuthedUntil({ exp })` — authed with a known unix-seconds expiry. The
 *    cookie/web path derives this from the readable expiry hint; a consumer that
 *    wants freshness without waiting for a re-derive can compare `exp` to now.
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
 * counts as not fresh: the cookie/web path derives `exp` from a client-readable
 * hint the server can already have expired, so a consumer that must not act on a
 * lapsed session — e.g. gating an authed-only fetch that would otherwise 401 —
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
