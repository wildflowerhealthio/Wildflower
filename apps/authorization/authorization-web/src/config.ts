/**
 * The OAuth client Wildflower Authorization signs in as: a random id
 * (`openssl rand -hex 16`), seeded on every Wildflower server by the
 * authorization server migration `0031_seed_authorization_web_client`. The
 * migration is the authority and this is the browser-side reading of it: a
 * value that drifts from the row fails the sign-in at `/oauth/authorize`.
 * `authorization-server-rust`'s `db/clients.rs` reads this file and pins the
 * row's id and scopes to it.
 */
const AUTHORIZATION_CLIENT_ID = '7277e898bee8ac81ea44788236e619a5'

/**
 * The scopes the app asks for, and the seeded client's `allowed_scopes`,
 * element for element:
 *
 * - `wildflower/Grant.rd` lists the grants and revokes one;
 * - `wildflower/Client.ru` lists the trusted apps and disables or enables one;
 * - `wildflower/Token.d` revokes every token a revoked grant's client holds
 *   (`POST /authorization/revocations`).
 */
const AUTHORIZATION_SCOPE = 'openid wildflower/Grant.rd wildflower/Client.ru wildflower/Token.d'

/**
 * The redirect URI of the published build, on the app's own origin, and the
 * first entry of the seeded row. A copy served anywhere else (a PR preview,
 * the dev server) derives its own from where it is served, which the row
 * doesn't hold, so its sign-in goes
 * through the consent prompt's "this app is asking to return somewhere new"
 * warning. This is the fallback for a page whose address no sign-in may return
 * to.
 */
const REGISTERED_REDIRECT_URI = 'https://authorization.wildflowerhealth.io/'

/**
 * The `sessionStorage` key the pending sign-in record lives at, namespaced
 * because a PR preview serves the app on one origin with the launcher and the
 * server-docs console, which run the same flow.
 */
const PENDING_AUTHORIZATION_KEY = 'authorization-web.pending-authorization'

/**
 * Where this app's telemetry goes once the visitor consents to it: its own
 * Sentry project, whose DSN is the `VITE_SENTRY_DSN_AUTHORIZATION_WEB` build
 * variable, with `authorization-web` as the `app` tag. A build that sets no DSN
 * reports nothing.
 */
const authorizationWebTelemetry = {
  dsn: import.meta.env.VITE_SENTRY_DSN_AUTHORIZATION_WEB ?? '',
  app: 'authorization-web',
} as const

export {
  AUTHORIZATION_CLIENT_ID,
  AUTHORIZATION_SCOPE,
  authorizationWebTelemetry,
  PENDING_AUTHORIZATION_KEY,
  REGISTERED_REDIRECT_URI,
}
