/**
 * This console's OAuth client registration, and the one place the published
 * page's identity is written down.
 *
 * The console signs in as the **public PKCE client `wildflower-server-docs`**,
 * seeded into every Wildflower server by
 * `slices/gatekeeper/gatekeeper-rust/migrations/0007_seed_wildflower_server_docs_client`.
 * {@link CLIENT_ID} MUST equal that migration's row: the server clamps the
 * request to the row's `allowed_scopes`, so a value that drifts from the seed
 * fails the flow at `/oauth/authorize` rather than degrading quietly. The
 * migration is the authority; this module is the browser-side reading of it
 * (the same arrangement `apps/web-trace/src/config.ts` uses).
 *
 * The **redirect URI is not written down here** — it is derived from where the
 * page is served, by `gatekeeper-core/smart-client`'s `redirectUriForPage`.
 */

/** The `client_id` the seeded row registers. */
const CLIENT_ID = 'wildflower-server-docs'

/**
 * The redirect URI of the **published** console, and the sole entry of the
 * seeded row — the one redirect that is genuinely registered. Every other copy
 * derives its own.
 */
const REGISTERED_REDIRECT_URI = 'https://wildflowerhealth.io/wildflower-server-docs/'

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

export {
  CLIENT_ID,
  PENDING_AUTHORIZATION_KEY,
  REGISTERED_REDIRECT_URI,
  REQUESTED_SCOPES,
  requestedScopeParameter,
}
