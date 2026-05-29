import type { HttpClient } from '@effect/platform'
import {
  queryOptions,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationResult,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { Effect, type Schema } from 'effect'
import type { BearerToken } from 'kitchen-sink/auth-token'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import type { Tunnel } from 'tunnel-core/http-api-definition'

import { buildTunnelAdminClientLayer } from './client/tunnel-client.ts'

type TunnelState = Schema.Schema.Type<typeof Tunnel.TunnelStateSchema>
type TunnelPatchPayload = Schema.Schema.Type<typeof Tunnel.SetTunnelRequestBodySchema>

/**
 * Run an authenticated tunnel effect. Structurally identical to the
 * app's `RunAuthed` (`apps/wildflower-react/src/bridges/router-context.ts`),
 * re-declared here so the slice does NOT import the app's
 * `RouterContext` — the slice stays decoupled from the app that hosts
 * it (per Issue #101). The app threads its concrete `runAuthed` into the
 * router context; loaders pass `context.runAuthed` and components read it
 * via `Route.useRouteContext()`, then hand it to the helpers below.
 *
 * The runner supplies `BearerToken` + `HttpClient.HttpClient`; each call
 * site provides the tunnel client layer (`buildTunnelAdminClientLayer()`),
 * which is exactly what leaves those two services unprovided — so the
 * requirement is satisfied with no `any` and no cast.
 */
type RunAuthed = <A, E>(
  effect: Effect.Effect<A, E, BearerToken | HttpClient.HttpClient>
) => Promise<A>

/**
 * Query key for {@link tunnelStateQueryOptions}. Mutations invalidate /
 * patch the cache at this key. Mutations elsewhere in the app that affect
 * `TunnelState` (e.g. host-bridge events) should invalidate this key.
 */
const TUNNEL_STATE_QUERY_KEY = ['tunnel', 'state'] as const

/**
 * Shared `queryOptions` for the daemon's `TunnelState`, generic over the
 * authed {@link RunAuthed} runner. The same `queryKey` + `queryFn` is
 * consumed by BOTH a route `loader` (via
 * `context.queryClient.ensureQueryData(tunnelStateQueryOptions(context.runAuthed))`)
 * AND the screen component (via {@link useTunnelStateQuery}), so a
 * loader-warmed entry makes the component's read instant.
 *
 * The `queryFn` mirrors PR #102's call shape: it runs `GetTunnel`
 * through `runAuthed`, providing the tunnel admin client layer — that
 * layer requires `BearerToken | HttpClient`, which `runAuthed` supplies.
 */
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

/**
 * Suspense-backed read of the daemon's `TunnelState`, off the shared
 * in-memory query cache. When the route `loader` has already called
 * `ensureQueryData(tunnelStateQueryOptions(runAuthed))`, this resolves
 * synchronously from cache (instant first paint); otherwise it fetches
 * on mount.
 *
 * Takes the authed runner explicitly (rather than reading it from a
 * provider) so the slice carries no DI machinery — the caller obtains
 * `runAuthed` from the router context (`Route.useRouteContext()`).
 */
const useTunnelStateQuery = (runAuthed: RunAuthed): UseSuspenseQueryResult<TunnelState, Error> =>
  useSuspenseQuery(tunnelStateQueryOptions(runAuthed))

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
 * `PatchTunnel` mutation with cache-side optimistic application, generic
 * over the authed {@link RunAuthed} runner:
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
const useTunnelPatchMutation = (
  runAuthed: RunAuthed
): UseMutationResult<TunnelState, Error, TunnelPatchPayload, TunnelPatchMutationContext> => {
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
