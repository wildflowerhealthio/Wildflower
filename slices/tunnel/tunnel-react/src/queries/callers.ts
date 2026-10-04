import {
  queryOptions,
  useQuery,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query'
import { Effect, type Schema } from 'effect'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import type { Tunnel } from 'tunnel-core/http-api-definition'

import { buildTunnelAdminClientLayer } from '../client/tunnel-client.ts'
import type { RunAuthed } from '../router-context.ts'
import { TUNNEL_CALLERS_QUERY_KEY } from './keys.ts'
import type { LiveQueryOptions } from './live-query-options.ts'
import { useRunAuthed } from './use-run-authed.ts'

/** What the request log holds for one (caller, client address) pair. */
type CallerSummary = Schema.Schema.Type<typeof Tunnel.CallerSummarySchema>

/**
 * `ListCallers` — one row per (caller, client address), the most recently seen
 * first. Shared by the activity card and the activity page's client summary.
 */
const tunnelCallersQueryOptions = (
  runAuthed: RunAuthed
): UseQueryOptions<
  readonly CallerSummary[],
  Error,
  readonly CallerSummary[],
  typeof TUNNEL_CALLERS_QUERY_KEY
> =>
  queryOptions({
    queryKey: TUNNEL_CALLERS_QUERY_KEY,
    queryFn: () =>
      runAuthed(
        Effect.flatMap(TunnelAdminHttpApiClient, (c) => c.tunnel.ListCallers()).pipe(
          Effect.provide(buildTunnelAdminClientLayer())
        )
      ),
  })

/**
 * Not a suspense query: the log is secondary to the screens that show it, so a
 * failed read renders in place rather than replacing the page.
 */
const useTunnelCallersQuery = (
  options?: LiveQueryOptions
): UseQueryResult<readonly CallerSummary[], Error> =>
  useQuery({ ...tunnelCallersQueryOptions(useRunAuthed()), ...options })

export { tunnelCallersQueryOptions, useTunnelCallersQuery }
export type { CallerSummary }
