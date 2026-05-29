import {
  queryOptions,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationResult,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { Effect, type Schema } from 'effect'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import type { Tunnel } from 'tunnel-core/http-api-definition'

import { buildTunnelAdminClientLayer } from './client/tunnel-client.ts'
import type { RouterContext, RunAuthed } from './router-context.ts'

// Annotated `select` so the result stays typed when the slice's router
// isn't registered (standalone build).
const useRunAuthed = (): RunAuthed =>
  useRouteContext({ from: '__root__', select: (context: RouterContext) => context.runAuthed })

type TunnelState = Schema.Schema.Type<typeof Tunnel.TunnelStateSchema>
type TunnelPatchPayload = Schema.Schema.Type<typeof Tunnel.SetTunnelRequestBodySchema>

/** External mutators of `TunnelState` (e.g. host-bridge events) should invalidate this. */
const TUNNEL_STATE_QUERY_KEY = ['tunnel', 'state'] as const

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

/**
 * Apply a `PatchTunnel` payload to a cached `TunnelState` snapshot
 * using the wire schema's semantics:
 *
 *   - `undefined` field → preserve previous value
 *   - non-`undefined` field (incl. `null`) → write through
 *
 * Server-derived fields (`running`, `current*`, `error`, `servedOrigin`)
 * are never optimistically set — they're left untouched so the UI
 * keeps showing the last-known reality until the mutation settles and
 * the cache is invalidated.
 */
const applyTunnelOptimistic = (
  previous: TunnelState,
  payload: TunnelPatchPayload
): TunnelState => ({
  ...previous,
  subdomain: payload.subdomain === undefined ? previous.subdomain : payload.subdomain,
  rootDomain: payload.rootDomain === undefined ? previous.rootDomain : payload.rootDomain,
  requestedRunning:
    payload.requestedRunning === undefined ? previous.requestedRunning : payload.requestedRunning,
})

interface TunnelPatchMutationContext {
  readonly previous: TunnelState | undefined
}

/**
 * `PatchTunnel` with optimistic cache update + rollback. Server-derived
 * fields (`running`, `current*`, `error`) come back via `onSettled`'s
 * invalidate, not from the optimistic projection.
 */
const useTunnelPatchMutation = (): UseMutationResult<
  TunnelState,
  Error,
  TunnelPatchPayload,
  TunnelPatchMutationContext
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation<TunnelState, Error, TunnelPatchPayload, TunnelPatchMutationContext>({
    mutationFn: (payload) =>
      runAuthed(
        Effect.flatMap(TunnelAdminHttpApiClient, (c) => c.tunnel.PatchTunnel({ payload })).pipe(
          Effect.provide(buildTunnelAdminClientLayer())
        )
      ),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: TUNNEL_STATE_QUERY_KEY })
      const previous = queryClient.getQueryData<TunnelState>(TUNNEL_STATE_QUERY_KEY)
      if (previous !== undefined) {
        queryClient.setQueryData<TunnelState>(
          TUNNEL_STATE_QUERY_KEY,
          applyTunnelOptimistic(previous, payload)
        )
      }
      return { previous }
    },
    onError: (_err, _payload, context) => {
      if (context !== undefined && context.previous !== undefined) {
        queryClient.setQueryData<TunnelState>(TUNNEL_STATE_QUERY_KEY, context.previous)
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: TUNNEL_STATE_QUERY_KEY })
    },
  })
}

export {
  applyTunnelOptimistic,
  TUNNEL_STATE_QUERY_KEY,
  tunnelStateQueryOptions,
  useTunnelPatchMutation,
  useTunnelStateQuery,
}
export type { RunAuthed, TunnelPatchPayload, TunnelState }
