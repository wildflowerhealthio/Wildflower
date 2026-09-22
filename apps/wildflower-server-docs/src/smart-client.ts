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
 *
 * Neither are the **requested scopes**: they are the standalone-launch
 * vocabulary `STANDALONE_LAUNCH_SCOPES` shares with the `wildflower-react`
 * page. The two seeded rows register identical `allowed_scopes` (`db/clients.rs`
 * has a test that fails if they drift), so the browser side is one list too.
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
 * The `sessionStorage` key this console's pending-authorization record lives at,
 * namespaced because the console shares both the flow in
 * `gatekeeper-core/smart-client` and the `wildflowerhealth.io` origin with the
 * hosted owner UI.
 */
const PENDING_AUTHORIZATION_KEY = 'wildflower-server-docs.pending-authorization'

export { CLIENT_ID, PENDING_AUTHORIZATION_KEY, REGISTERED_REDIRECT_URI }
