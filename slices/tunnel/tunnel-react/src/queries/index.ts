/**
 * The tunnel TanStack-Query surface, split by the resource each module deals
 * with:
 *
 *   - {@link file://./tunnel-state.ts}  — tunnel state (read + optimistic replace)
 *   - {@link file://./callers.ts}       — the request log grouped by caller (`ListCallers`)
 *   - {@link file://./requests.ts}      — the request log's pages (`ListRequests`) and export
 *   - {@link file://./client-names.ts}  — gatekeeper's client display names, by `clientId`
 *
 * {@link file://./live-query-options.ts} holds the polling options the
 * request-log hooks take.
 *
 * Shared scaffolding lives in {@link file://./keys.ts} (the query-key roots
 * mutations invalidate) and {@link file://./use-run-authed.ts} (the authed-runner
 * hook each `queryFn` reads from router context).
 *
 * Re-exported flat so call sites import from `./queries` without caring
 * which resource module a hook lives in.
 */

export {
  RECENT_REFUSED_REQUESTS_QUERY_KEY,
  TUNNEL_CALLERS_QUERY_KEY,
  TUNNEL_REQUESTS_QUERY_KEY,
  TUNNEL_STATE_QUERY_KEY,
  tunnelRequestsPagesQueryKey,
} from './keys.ts'
export { useRunAuthed } from './use-run-authed.ts'

export {
  applyTunnelOptimistic,
  buildReplacePayload,
  isTunnelState,
  mightTunnelBeOpen,
  tunnelStateQueryOptions,
  useTunnelReplaceMutation,
  useTunnelStateQuery,
} from './tunnel-state.ts'
export type {
  RelayInput,
  TunnelReplaceInput,
  TunnelReplaceResult,
  TunnelState,
} from './tunnel-state.ts'

export { tunnelCallersQueryOptions, useTunnelCallersQuery } from './callers.ts'
export type { CallerSummary } from './callers.ts'

export {
  listEveryRequest,
  recentRefusedRequestsQueryOptions,
  tunnelRequestsInfiniteQueryOptions,
  useExportRequestsMutation,
  useRecentRefusedRequestsQuery,
  useTunnelRequestsQuery,
} from './requests.ts'
export type {
  LoggedRequest,
  RequestAuth,
  RequestLogCursor,
  RequestLogFilter,
  RequestLogPage,
} from './requests.ts'

export { useClientNames } from './client-names.ts'

export type { LiveQueryOptions } from './live-query-options.ts'

export type { RunAuthed } from '../router-context.ts'
