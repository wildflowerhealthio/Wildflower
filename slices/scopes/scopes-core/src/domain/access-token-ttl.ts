/**
 * The gatekeeper access-token lifetime, and the consent copy computed from it. There is no
 * shared TS ⇄ Rust constant for it, so {@link ttlMinutes} is kept in step with
 * `gatekeeper-rust`'s `ACCESS_TOKEN_TTL` (`http/handlers/oauth/internal.rs`) by convention —
 * change both together.
 *
 * Namespace module (`import { AccessToken } from 'scopes-core'`).
 */

/** The access-token lifetime in minutes — the single source the consent copy phrases from. */
const ttlMinutes = 15

/**
 * The "access ends when the short-lived token expires" consent line, phrased from a TTL in
 * minutes ({@link ttlMinutes} by default). Shown two ways: as the `offline_access`
 * explanation (what granting it unlocks) and as the "It won't be able to…" exclusion when
 * `offline_access` is absent — so the minute figure lives in exactly one place.
 */
const accessAfterExpiryCopy = (minutes: number = ttlMinutes): string =>
  `Access your data after ${minutes} minutes`

export { ttlMinutes, accessAfterExpiryCopy }
