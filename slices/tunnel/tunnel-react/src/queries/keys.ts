/**
 * Query-key roots shared across the tunnel resource modules.
 *
 * Mutations and external events invalidate the matching root so the next
 * render refetches.
 */

/** External mutators of `TunnelState` (e.g. host-bridge events) should invalidate this. */
const TUNNEL_STATE_QUERY_KEY = ['tunnel', 'state'] as const

export { TUNNEL_STATE_QUERY_KEY }
