/**
 * This console's OAuth client registration, and the one place the published
 * page's identity is written down.
 *
 * The console signs in as the **public PKCE client
 * `664a01e8614050cd82ffe90350b81413`**, seeded into every Wildflower server by
 * `apps/host/wildflower-server/authorization-server-rust/migrations/0007_seed_wildflower_server_docs_client`
 * (as `server-docs`), re-keyed to that random id by
 * `0028_rekey_site_app_clients`, and given its own origin's redirect by
 * `0036_add_app_origin_redirect_uris`.
 * {@link CLIENT_ID} MUST equal that migration's row: the server clamps the
 * request to the row's `allowed_scopes`, so a value that drifts from the seed
 * fails the flow at `/oauth/authorize` rather than degrading quietly. The
 * migration is the authority; this module is the browser-side reading of it
 * (the same arrangement `apps/importer-web/src/config.ts` uses).
 *
 * The **redirect URI is not written down here** — it is derived from where the
 * page is served, by `authorization-core/smart-client`'s `redirectUriForPage`.
 *
 * Neither are the **requested scopes**: they are the standalone-launch
 * vocabulary `STANDALONE_LAUNCH_SCOPES` in `authorization-core/smart-client`.
 */

/** The `client_id` the seeded row registers. */
const CLIENT_ID = '664a01e8614050cd82ffe90350b81413'

/**
 * The redirect URI of the **published** console, on its own origin, and the
 * first entry of the seeded row. Every other copy derives its own.
 */
const REGISTERED_REDIRECT_URI = 'https://server-docs.wildflowerhealth.io/'

/**
 * The `sessionStorage` key this console's pending-authorization record lives at,
 * namespaced because the console shares the flow in
 * `authorization-core/smart-client` with the hosted launcher and Wildflower
 * Authorization, so no two of them could share a key wherever they are served.
 */
const PENDING_AUTHORIZATION_KEY = 'server-docs-web.pending-authorization'

export { CLIENT_ID, PENDING_AUTHORIZATION_KEY, REGISTERED_REDIRECT_URI }
