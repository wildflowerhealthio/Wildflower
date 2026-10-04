import type { RequestLogFilter } from './requests.ts'

/**
 * Query-key roots shared across the tunnel resource modules.
 *
 * Mutations and external events invalidate the matching root so the next
 * render refetches. Every request-log read sits under
 * {@link TUNNEL_REQUESTS_QUERY_KEY}, so anything that writes the log
 * invalidates the callers summary and every filtered page at once.
 */

/** External mutators of `TunnelState` (e.g. host-bridge events) should invalidate this. */
const TUNNEL_STATE_QUERY_KEY = ['tunnel', 'state'] as const

/** Root of every request-log read; anything that writes the log invalidates under it. */
const TUNNEL_REQUESTS_QUERY_KEY = ['tunnel', 'requests'] as const

const TUNNEL_CALLERS_QUERY_KEY = [...TUNNEL_REQUESTS_QUERY_KEY, 'callers'] as const

/** The `ListRequests` pages read under `filter`. */
const tunnelRequestsPagesQueryKey = (
  filter: RequestLogFilter
): readonly [...typeof TUNNEL_REQUESTS_QUERY_KEY, 'pages', RequestLogFilter] => [
  ...TUNNEL_REQUESTS_QUERY_KEY,
  'pages',
  filter,
]

export {
  TUNNEL_CALLERS_QUERY_KEY,
  TUNNEL_REQUESTS_QUERY_KEY,
  TUNNEL_STATE_QUERY_KEY,
  tunnelRequestsPagesQueryKey,
}
