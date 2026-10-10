/**
 * The request-log TanStack-Query surface, split by the resource each module
 * deals with:
 *
 *   - {@link file://./callers.ts}       — the log grouped by caller (`ListCallers`)
 *   - {@link file://./requests.ts}      — the log's pages (`ListRequests`) and export
 *   - {@link file://./client-names.ts}  — gatekeeper's client display names, by `clientId`
 *   - {@link file://./refresh.ts}       — the manual re-read of every request-log query
 *
 * Shared scaffolding lives in {@link file://./keys.ts} (the query-key roots)
 * and {@link file://./use-run-authed.ts} (the authed-runner hook each
 * `queryFn` reads from router context).
 *
 * Re-exported flat so call sites import from `./queries` without caring
 * which resource module a hook lives in.
 */

export {
  CALLERS_QUERY_KEY,
  RECENT_REFUSED_REQUESTS_QUERY_KEY,
  REQUEST_LOG_QUERY_KEY,
  requestsPagesQueryKey,
} from './keys.ts'
export { useRunAuthed } from './use-run-authed.ts'

export { callersQueryOptions, useCallersQuery } from './callers.ts'
export type { CallerSummary } from './callers.ts'

export {
  listEveryRequest,
  recentRefusedRequestsQueryOptions,
  requestsInfiniteQueryOptions,
  useExportRequestsMutation,
  useRecentRefusedRequestsQuery,
  useRequestsQuery,
} from './requests.ts'
export type {
  LoggedRequest,
  RequestAuth,
  RequestLogCursor,
  RequestLogFilter,
  RequestLogPage,
} from './requests.ts'

export { useClientNames } from './client-names.ts'

export { useRefreshRequestLog } from './refresh.ts'

export type { RunAuthed } from '../router-context.ts'
