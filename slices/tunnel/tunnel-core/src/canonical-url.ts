/**
 * Canonical public-tunnel URL the wildflower-expo host requests when it
 * wants the device's HTTP server reachable from outside. apps-core
 * commits this value as `requestedPublicOrigin` on the TunnelStore;
 * `tunnel-expo`'s daemon hands the subdomain off to `TunnelExpo.acquire`
 * and only writes `currentPublicOrigin` if the upstream grants exactly
 * this URL.
 *
 * Kept hardcoded here (rather than per-host config) so the request URL
 * and the acquire-call subdomain stay in lock-step — they're literally
 * the same string derived from the same constants.
 */
const TUNNEL_SUBDOMAIN = 'wildflower-expo-dev'
const TUNNEL_HOST = 'loca.lt'

const canonicalPublicOrigin = (): string => `https://${TUNNEL_SUBDOMAIN}.${TUNNEL_HOST}`

export { canonicalPublicOrigin, TUNNEL_HOST, TUNNEL_SUBDOMAIN }
