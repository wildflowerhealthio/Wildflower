/**
 * Client id of the Wildflower host app's Owner client — the standalone/web
 * fallback.
 *
 * The server-side authorization server (token minting, signing-key/essential-client
 * seeding, OAuth consent decisions, expiry cleanup) lives in `authorization-server-rust`.
 * On the live Tauri app the id is sourced from `tauri-shared-config.json` and
 * threaded through router context (`useWildflowerHostAppClientId`), the single
 * source shared with the Rust seeder, so it can't drift across the boundary. This
 * constant is only the fallback `NeedsAuthMessage` uses when no host context
 * carries the id (standalone/web builds); it matches authorization-server-rust's own
 * `WILDFLOWER_HOST_APP_CLIENT_ID` fallback and the config's `wildflower_host_app_client_id`.
 */
export const WILDFLOWER_HOST_APP_CLIENT_ID = 'wildflower-host'
