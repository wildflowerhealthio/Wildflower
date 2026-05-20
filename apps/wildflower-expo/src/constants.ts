/** Default OTEL service name for the on-device wildflower-expo host. */
const SERVICE_NAME = 'wildflower-expo'

/** Default HTTP port for the on-device wildflower-expo host. */
const PORT = 8080

/**
 * Canonical tunnel target seeded into `TunnelConfig` at first launch.
 * Subsequent boots preserve whatever the user wrote — these are the
 * fallback when the persistent row is absent. The host doesn't enforce
 * these values per-toggle; `setTunnelActive` only flips
 * `requestedRunning`, so a user who customizes the subdomain via the
 * settings UI keeps their override.
 */
const TUNNEL_SUBDOMAIN = 'wildflower-expo-dev'
const TUNNEL_ROOT_DOMAIN = 'loca.lt'

export { PORT, SERVICE_NAME, TUNNEL_ROOT_DOMAIN, TUNNEL_SUBDOMAIN }
