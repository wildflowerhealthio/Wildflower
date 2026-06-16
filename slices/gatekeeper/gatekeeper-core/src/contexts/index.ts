/**
 * Client id of the host's first-party Owner client.
 *
 * The server-side gatekeeper (token minting, signing-key/first-party-client
 * seeding, OAuth consent decisions, expiry cleanup) now lives in
 * `gatekeeper-rust`; the former TS `contexts` server helpers were removed
 * with the rest of the TS server stack. This constant is the one value the
 * React UI still references (e.g. `NeedsAuthMessage` distinguishes the host's
 * own client), so it stays here — mirroring the id `gatekeeper-rust` seeds.
 */
export const FIRST_PARTY_CLIENT_ID = 'wildflower-host'
