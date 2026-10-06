import {
  queryOptions,
  useSuspenseQuery,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { Effect, type Schema } from 'effect'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import type { Tunnel } from 'tunnel-core/http-api-definition'

import { buildTunnelAdminClientLayer } from '../client/tunnel-client.ts'
import type { RunAuthed } from '../router-context.ts'
import { TUNNEL_STATE_QUERY_KEY } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

type TunnelState = Schema.Schema.Type<typeof Tunnel.TunnelStateViewSchema>

/** Shared by the route `loader` (`ensureQueryData`) and {@link useTunnelStateQuery}. */
const tunnelStateQueryOptions = (
  runAuthed: RunAuthed
): UseSuspenseQueryOptions<TunnelState, Error, TunnelState, typeof TUNNEL_STATE_QUERY_KEY> =>
  queryOptions({
    queryKey: TUNNEL_STATE_QUERY_KEY,
    queryFn: () =>
      runAuthed(
        Effect.flatMap(TunnelAdminHttpApiClient, (c) => c.tunnel.GetTunnel()).pipe(
          Effect.provide(buildTunnelAdminClientLayer())
        )
      ),
  })

/** Reads synchronously from cache when the route loader has already warmed it. */
const useTunnelStateQuery = (): UseSuspenseQueryResult<TunnelState, Error> =>
  useSuspenseQuery(tunnelStateQueryOptions(useRunAuthed()))

export { tunnelStateQueryOptions, useTunnelStateQuery }
export type { TunnelState }
