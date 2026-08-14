/**
 * This console's OAuth client registration, and the one place the published
 * page's identity is written down.
 *
 * The console signs in as the **public PKCE client `wildflower-server-docs`**,
 * seeded into every Wildflower server by
 * `slices/gatekeeper/gatekeeper-rust/migrations/0007_seed_wildflower_server_docs_client`.
 * The values below MUST equal that migration's row: the server matches
 * `redirect_uri` by exact string equality and clamps the request to
 * `allowed_scopes`, so a value that drifts from the seed fails the flow at
 * `/oauth/authorize` rather than degrading quietly. The migration is the
 * authority; this module is the browser-side reading of it (the same
 * arrangement `apps/web-trace/src/config.ts` uses for its own registration).
 */

/** The `client_id` the seeded row registers. */
export const CLIENT_ID = 'wildflower-server-docs'

/**
 * The single redirect URI the seeded row registers — the published console's
 * own directory URL, trailing slash included.
 *
 * It carries no query string, and the server appends only `code` and `state` on
 * the way back, so anything the console wants to survive the round trip travels
 * in the pending-authorization record rather than in the URL (see
 * `authorization-flow.ts`).
 */
export const REGISTERED_REDIRECT_URI = 'https://wildflower-health.io/wildflower-server-docs/'

/**
 * The scopes the console asks for: the whole ceiling the seeded row allows.
 *
 * Asking wide is deliberate. The console is a request client for *every*
 * documented slice, so it cannot know in advance which surface a reader will
 * try; `allowed_scopes` is only the ceiling on what may be **requested**, and
 * the Owner's consent step is where the grant is actually narrowed (the
 * migration's own comment says so). Requesting less would silently break the
 * "send request" button on surfaces the reader is entitled to.
 */
export const REQUESTED_SCOPES: readonly string[] = [
  'openid',
  'profile',
  'fhirUser',
  'launch',
  'launch/patient',
  'offline_access',
  'wildflower/launch',
  'system/*.cruds',
  'wildflower/*.cruds',
]

/** The space-delimited `scope` parameter form of {@link REQUESTED_SCOPES}. */
export const requestedScopeParameter = (): string => REQUESTED_SCOPES.join(' ')

/**
 * Whether the console can complete a sign-in from `href`, and why not when it
 * cannot.
 *
 * Only the published copy can: the seeded client registers exactly one redirect
 * URI, and `/oauth/authorize` matches it by exact URL equality, so a copy served
 * from anywhere else (a `vp dev` server, a preview build, a fork's Pages site)
 * has no redirect the server would honour. Detecting that here is what lets the
 * header bar disable its button with a reason instead of sending the reader to
 * an `invalid_request` page.
 *
 * Origin and path are compared with trailing slashes trimmed, so
 * `/wildflower-server-docs` and `/wildflower-server-docs/` — the same page,
 * before and after the host's canonicalising redirect — both count.
 */
export const signInAvailability = (
  href: string
): { readonly available: true } | { readonly available: false; readonly reason: string } => {
  const registered = new URL(REGISTERED_REDIRECT_URI)
  let here: URL
  try {
    here = new URL(href)
  } catch {
    return { available: false, reason: 'This page has no usable address to return to.' }
  }
  const samePlace =
    here.origin === registered.origin &&
    here.pathname.replace(/\/+$/, '') === registered.pathname.replace(/\/+$/, '')
  if (samePlace) return { available: true }
  return {
    available: false,
    reason:
      `Sign-in works only on the published console at ${REGISTERED_REDIRECT_URI} — ` +
      'the one redirect URI this client is registered for. Paste a token into a ' +
      'request’s Authorization field instead.',
  }
}
