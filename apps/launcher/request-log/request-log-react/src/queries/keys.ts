import type { RequestLogFilter } from './requests.ts'

/**
 * Query-key roots shared across the request-log resource modules. Every
 * request-log read sits under {@link REQUEST_LOG_QUERY_KEY}, so one
 * invalidation (see `useRefreshRequestLog`) re-reads the callers summary, the
 * newest refused requests and every filtered page at once.
 */

/** Root of every request-log read; refreshing the log invalidates under it. */
const REQUEST_LOG_QUERY_KEY = ['request-log'] as const

const CALLERS_QUERY_KEY = [...REQUEST_LOG_QUERY_KEY, 'callers'] as const

const RECENT_REFUSED_REQUESTS_QUERY_KEY = [...REQUEST_LOG_QUERY_KEY, 'recent-refused'] as const

/** The `ListRequests` pages read under `filter`. */
const requestsPagesQueryKey = (
  filter: RequestLogFilter
): readonly [...typeof REQUEST_LOG_QUERY_KEY, 'pages', RequestLogFilter] => [
  ...REQUEST_LOG_QUERY_KEY,
  'pages',
  filter,
]

export {
  CALLERS_QUERY_KEY,
  RECENT_REFUSED_REQUESTS_QUERY_KEY,
  REQUEST_LOG_QUERY_KEY,
  requestsPagesQueryKey,
}
