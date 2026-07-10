/**
 * Client id of the host's first-party Owner client — the standalone/web
 * fallback.
 *
 * The server-side gatekeeper (token minting, signing-key/first-party-client
 * seeding, OAuth consent decisions, expiry cleanup) lives in `gatekeeper-rust`.
 * On the live Tauri app the id is sourced from `tauri-shared-config.json` and
 * threaded through router context (`useGatekeeperFirstPartyClientId`), the single
 * source shared with the Rust seeder, so it can't drift across the boundary. This
 * constant is only the fallback `NeedsAuthMessage` uses when no host context
 * carries the id (standalone/web builds); it matches gatekeeper-rust's own
 * `FIRST_PARTY_CLIENT_ID` fallback and the config's `first_party_client_id`.
 */
export const FIRST_PARTY_CLIENT_ID = 'wildflower-host'
