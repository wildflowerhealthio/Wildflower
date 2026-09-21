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
 * flow without deploying.
 *
 * **This one is not seeded.** No migration lists it —
 * `0007_seed_wildflower_server_docs_client`'s `redirect_uris` carries the
 * published URL alone — because a server is expected to accept a loopback
 * developer redirect on first use through the Owner's trust-on-first-use
 * consent (#688–#690). Until that lands, a server without this entry added by
 * hand answers the dev-server sign-in with `invalid_request`. The seed is the
 * authority for what is registered, so do not describe this as registered.
 */
const LOCAL_DEV_REDIRECT_URI = 'http://127.0.0.1:5192'

/**
 * Every redirect URI this console knows a server may honour, in preference
 * order: the seeded published URL first, then the loopback dev server the Owner
 * approves on first use. The console returns to whichever one matches where it
 * is being served (see {@link signInAvailability}); the published URI is first,
 * so it is the one any reason string and the sign-in environment's default fall
 * back to.
 */
const KNOWN_REDIRECT_URIS: readonly string[] = [REGISTERED_REDIRECT_URI, LOCAL_DEV_REDIRECT_URI]

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
 * The `sessionStorage` key this console's pending-authorization record lives at,
 * namespaced because the console shares both the flow in
 * `gatekeeper-core/smart-client` and the `wildflowerhealth.io` origin with the
 * hosted owner UI.
 */
const PENDING_AUTHORIZATION_KEY = 'wildflower-server-docs.pending-authorization'

/**
 * The known redirect URI a console served at `href` returns to, or `undefined`
 * when `href` is none of them.
 *
 * `/oauth/authorize` matches the redirect by exact URL equality, so the string
 * returned here is the one to send — the literal known entry, not `href`
 * itself. Origin and path are compared with trailing slashes trimmed, so
 * `/wildflower-server-docs` and `/wildflower-server-docs/` — the same page,
 * before and after the host's canonicalising redirect — both count; the query
 * and fragment are the console's own state and never affect the match.
 */
const knownRedirectUriFor = (href: string): string | undefined => {
  let here: URL
  try {
    here = new URL(href)
  } catch {
    return undefined
  }
  return KNOWN_REDIRECT_URIS.find((uri) => {
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
 * `/oauth/authorize` matches the redirect by exact URL equality, and
 * {@link KNOWN_REDIRECT_URIS} is what this console knows to send. A copy served
 * anywhere else (a preview build, a fork's Pages site, an unpinned dev port) has
 * none — a statement about what this page knows, **not** a claim that the copy
 * is unregistered, which it cannot know. Detecting it lets the header bar
 * disable its button with an explanation instead of sending the reader to an
 * `invalid_request` page.
 */
const signInAvailability = (
  href: string
):
  | { readonly available: true; readonly redirectUri: string }
  | { readonly available: false; readonly reason: string } => {
  const redirectUri = knownRedirectUriFor(href)
  if (redirectUri !== undefined) return { available: true, redirectUri }
  return {
    available: false,
    reason:
      `This copy of the console is not served from an address it knows how to return to, so ` +
      `it cannot start a sign-in. The published console at ${REGISTERED_REDIRECT_URI} can. ` +
      'Paste a token into a request’s Authorization field instead.',
  }
}

export {
  CLIENT_ID,
  KNOWN_REDIRECT_URIS,
  LOCAL_DEV_REDIRECT_URI,
  PENDING_AUTHORIZATION_KEY,
  REGISTERED_REDIRECT_URI,
  REQUESTED_SCOPES,
  requestedScopeParameter,
  signInAvailability,
}
