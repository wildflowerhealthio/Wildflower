import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationResult,
  type UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { Effect, type Schema } from 'effect'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import type { Tunnel } from 'tunnel-core/http-api-definition'

import { useTunnelAdminEffectRunner } from './use-tunnel-admin-effect-runner.ts'

type TunnelState = Schema.Schema.Type<typeof Tunnel.TunnelStateSchema>
type TunnelPatchPayload = Schema.Schema.Type<typeof Tunnel.SetTunnelRequestBodySchema>

/**
 * Query key for {@link useTunnelStateQuery}. Mutations invalidate /
 * patch the cache at this key; persisting it via TanStack Query's
 * localStorage persister keys the snapshot too. Mutations elsewhere in
 * the app that affect `TunnelState` (e.g. host-bridge events) should
 * invalidate this key.
 */
const TUNNEL_STATE_QUERY_KEY = ['tunnel', 'state'] as const

/**
 * Suspense-backed read of the daemon's `TunnelState`. The query stays
 * in cache (and is persisted) across reloads; with `staleTime: 0` set
 * on the global `QueryClient`, the first render after a remount triggers
 * a background refetch that swaps in fresh data once the daemon replies.
 *
 * Use this from any owner-facing tunnel screen. Mutations should pair
 * with {@link useTunnelPatchMutation}, which optimistically updates
 * this key.
 */
const useTunnelStateQuery = (): UseSuspenseQueryResult<TunnelState, Error> => {
  const run = useTunnelAdminEffectRunner()
  return useSuspenseQuery({
    queryKey: TUNNEL_STATE_QUERY_KEY,
    queryFn: () => run(Effect.flatMap(TunnelAdminHttpApiClient, (c) => c.tunnel.GetTunnel())),
  })
}

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
 * `PatchTunnel` mutation with cache-side optimistic application:
 *
 *   - `onMutate` snapshots the current `TunnelState` and writes an
 *     optimistic projection back into the cache so listeners (the
 *     settings screen) re-render with the requested-but-not-yet-acked
 *     values.
 *   - `onError` rolls the cache back to the snapshot.
 *   - `onSettled` invalidates the query so the daemon's authoritative
 *     `TunnelState` replaces the optimistic snapshot — picking up
 *     `running`, `current*`, and any new `error` from the response.
 *
 * Use `mutation.isPending` to disable the inputs during the in-flight
 * window.
 */
const useTunnelPatchMutation = (): UseMutationResult<
  TunnelState,
  Error,
  TunnelPatchPayload,
  TunnelPatchMutationContext
> => {
  const run = useTunnelAdminEffectRunner()
  const queryClient = useQueryClient()
  return useMutation<TunnelState, Error, TunnelPatchPayload, TunnelPatchMutationContext>({
    mutationFn: (payload) =>
      run(Effect.flatMap(TunnelAdminHttpApiClient, (c) => c.tunnel.PatchTunnel({ payload }))),
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
  useTunnelPatchMutation,
  useTunnelStateQuery,
}
export type { TunnelPatchPayload, TunnelState }
