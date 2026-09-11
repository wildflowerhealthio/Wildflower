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
const CLIENT_ID = 'wildflower-server-docs'

/**
 * The redirect URI the **published** console returns to — its own directory URL,
 * trailing slash included, and the primary entry of the seeded row.
 *
 * It carries no query string, and the server appends only `code` and `state` on
 * the way back, so anything the console wants to survive the round trip travels
 * in the pending-authorization record rather than in the URL (see
 * `authorization-flow.ts`).
 */
const REGISTERED_REDIRECT_URI = 'https://wildflowerhealth.io/wildflower-server-docs/'

/**
 * The redirect URI the console returns to when it is served from its **local dev
 * server** — `vp run -F wildflower-server-docs dev`, pinned to the
 * `web-server-docs-dev` port (5192) in `slices/apps/dev-app-ports.json`.
 *
 * Sent alongside the published URI so a developer can drive the whole sign-in
 * flow without deploying. `/oauth/authorize` matches the redirect by exact
 * string equality, so this MUST equal the loopback entry the gatekeeper seed
 * registers for this client — no trailing slash, matching the loopback origin
 * the dev server is reached at. The seed's `redirect_uris` is the authority: a
 * server whose `wildflower-server-docs` row does not carry this entry rejects the
 * dev-server sign-in at `/oauth/authorize` rather than honouring it.
 */
const LOCAL_DEV_REDIRECT_URI = 'http://127.0.0.1:5192'

/**
 * Every redirect URI the seeded row registers, in preference order. The console
 * returns to whichever one matches where it is being served (see
 * {@link signInAvailability}); the published URI is first, so it is the one any
 * reason string and the sign-in environment's default fall back to.
 */
const REGISTERED_REDIRECT_URIS: readonly string[] = [
  REGISTERED_REDIRECT_URI,
  LOCAL_DEV_REDIRECT_URI,
]

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
const REQUESTED_SCOPES: readonly string[] = [
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
const requestedScopeParameter = (): string => REQUESTED_SCOPES.join(' ')

/**
 * The registered redirect URI a console served at `href` returns to, or
 * `undefined` when `href` is not one of the registered consoles.
 *
 * `/oauth/authorize` matches the redirect by exact URL equality, so the string
 * returned here is the one to send — the literal registered entry, not `href`
 * itself. Origin and path are compared with trailing slashes trimmed, so
 * `/wildflower-server-docs` and `/wildflower-server-docs/` — the same page,
 * before and after the host's canonicalising redirect — both count; the query
 * and fragment are the console's own state and never affect the match.
 */
const registeredRedirectUriFor = (href: string): string | undefined => {
  let here: URL
  try {
    here = new URL(href)
  } catch {
    return undefined
  }
  return REGISTERED_REDIRECT_URIS.find((uri) => {
    const registered = new URL(uri)
    return (
      here.origin === registered.origin &&
      here.pathname.replace(/\/+$/, '') === registered.pathname.replace(/\/+$/, '')
    )
  })
}

/**
 * Whether the console can complete a sign-in from `href`, the redirect URI it
 * would return to when it can, and why not when it cannot.
 *
 * Only a registered copy can: the seeded client registers a fixed set of
 * redirect URIs (the published console and the loopback dev server), and
 * `/oauth/authorize` matches by exact URL equality, so a copy served from
 * anywhere else (a preview build, a fork's Pages site, an unpinned dev port) has
 * no redirect the server would honour. Detecting that here is what lets the
 * header bar disable its button with a reason instead of sending the reader to
 * an `invalid_request` page.
 */
const signInAvailability = (
  href: string
):
  | { readonly available: true; readonly redirectUri: string }
  | { readonly available: false; readonly reason: string } => {
  const redirectUri = registeredRedirectUriFor(href)
  if (redirectUri !== undefined) return { available: true, redirectUri }
  return {
    available: false,
    reason:
      `Sign-in works only on the published console at ${REGISTERED_REDIRECT_URI} — ` +
      'one of the redirect URIs this client is registered for. Paste a token into a ' +
      'request’s Authorization field instead.',
  }
}

export {
  CLIENT_ID,
  LOCAL_DEV_REDIRECT_URI,
  REGISTERED_REDIRECT_URI,
  REGISTERED_REDIRECT_URIS,
  REQUESTED_SCOPES,
  requestedScopeParameter,
  signInAvailability,
}
