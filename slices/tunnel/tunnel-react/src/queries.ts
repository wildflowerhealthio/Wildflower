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
import { Effect, Schema } from 'effect'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { Tunnel } from 'tunnel-core/http-api-definition'

import { buildTunnelAdminClientLayer } from './client/tunnel-client.ts'
import type { RouterContext, RunAuthed } from './router-context.ts'

// Annotated `select` so the result stays typed when the slice's router
// isn't registered (standalone build).
const useRunAuthed = (): RunAuthed =>
  useRouteContext({ from: '__root__', select: (context: RouterContext) => context.runAuthed })

type TunnelState = Schema.Schema.Type<typeof Tunnel.TunnelStateViewSchema>
type RelayInput = Schema.Schema.Type<typeof Tunnel.RelayInputSchema>
type ReplaceTunnelPayload = Schema.Schema.Type<typeof Tunnel.ReplaceTunnelRequestBodySchema>

/**
 * The user-controlled half of a `ReplaceTunnel` write. `revision` is
 * intentionally absent — the mutation always reads the freshest one from
 * the cache (see {@link useTunnelReplaceMutation}), so a stale-cache
 * toggle can't clobber a host the user just saved.
 *
 *   - `publicHost` omitted → keep the latest cached host; `null` clears
 *     it; a string sets it.
 *   - `requestedRunning` omitted → keep the latest cached run intent.
 *   - `relay` omitted → keep the stored relay; present → replace all four
 *     fields (it's write-only, never echoed back).
 */
interface TunnelReplaceInput {
  readonly publicHost?: string | null
  readonly requestedRunning?: boolean
  readonly relay?: RelayInput
}

/**
 * Outcome of a `ReplaceTunnel` PUT. A `409` is an *expected* result, not
 * a transport error: the caller's `revision` was stale, so the server
 * applied no write and returned the current snapshot (with a newer
 * revision) for the client to rebase against.
 */
type TunnelReplaceResult =
  | { readonly _tag: 'Applied'; readonly state: TunnelState }
  | { readonly _tag: 'Conflict'; readonly current: TunnelState }

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
 * Build the full-replace PUT body from the latest cached snapshot plus
 * the user's intent. `revision` and any omitted visible field come from
 * `current`, so every PUT carries the freshest revision and never drops
 * a value the user didn't touch. `relay` is included only when supplied
 * (it's write-only — absent means "keep the stored relay").
 */
/**
 * The single "omitted-preserves / present-writes" merge for the visible,
 * client-writable fields (`publicHost`, `requestedRunning`). Shared by
 * {@link buildReplacePayload} (the PUT body) and {@link applyTunnelOptimistic}
 * (the optimistic projection) so the two never drift — add a visible field
 * here once and both follow.
 */
const mergeVisibleFields = (
  base: TunnelState,
  input: TunnelReplaceInput
): Pick<TunnelState, 'publicHost' | 'requestedRunning'> => ({
  publicHost: input.publicHost === undefined ? base.publicHost : input.publicHost,
  requestedRunning:
    input.requestedRunning === undefined ? base.requestedRunning : input.requestedRunning,
})

const buildReplacePayload = (
  current: TunnelState,
  input: TunnelReplaceInput
): ReplaceTunnelPayload => ({
  revision: current.revision,
  ...mergeVisibleFields(current, input),
  ...(input.relay === undefined ? {} : { relay: input.relay }),
})

/**
 * Project a {@link TunnelReplaceInput} onto a cached snapshot for the
 * optimistic update — only the visible, client-writable fields.
 * Server-derived fields (`running`, `error`, `attempt`, `servedOrigin`)
 * and `revision` are left untouched; they settle from the server's
 * response. `relay` is write-only and not part of the snapshot, so it's
 * never projected.
 */
const applyTunnelOptimistic = (previous: TunnelState, input: TunnelReplaceInput): TunnelState => ({
  ...previous,
  ...mergeVisibleFields(previous, input),
})

/**
 * Type guard for a `TunnelState`. The `ReplaceTunnel` 409 surfaces the
 * server's current snapshot in the client's error channel, decoded
 * against the state schema; this refinement separates that expected
 * conflict from genuine failures (HttpClientError, decode errors) that
 * don't structurally match. Built once at module scope — `Schema.is`
 * compiles the refinement, so it isn't rebuilt per call.
 */
const isTunnelState: (error: unknown) => error is TunnelState = Schema.is(
  Tunnel.TunnelStateViewSchema
)

interface TunnelReplaceMutationContext {
  readonly previous: TunnelState | undefined
}

/**
 * `ReplaceTunnel` with optimistic cache update + rollback. The PUT body
 * is built from the latest cached snapshot (not React state), so the
 * `revision` is always current and a toggle can't clobber an unrelated
 * field. A `409` resolves to a `Conflict` result (the server's current
 * snapshot is adopted into the cache and surfaced via
 * `mutation.data._tag`); genuine transport failures reject and roll the
 * optimistic write back.
 */
const useTunnelReplaceMutation = (): UseMutationResult<
  TunnelReplaceResult,
  Error,
  TunnelReplaceInput,
  TunnelReplaceMutationContext
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation<TunnelReplaceResult, Error, TunnelReplaceInput, TunnelReplaceMutationContext>({
    mutationFn: (input) => {
      const current = queryClient.getQueryData<TunnelState>(TUNNEL_STATE_QUERY_KEY)
      if (current === undefined) {
        // The route loader warms this cache before the form renders, so a
        // missing snapshot is a real bug — fail loudly rather than PUT a
        // guessed revision/host.
        return Promise.reject(new Error('Tunnel state not loaded; cannot replace settings.'))
      }
      const payload = buildReplacePayload(current, input)
      return runAuthed(
        Effect.flatMap(TunnelAdminHttpApiClient, (c) => c.tunnel.ReplaceTunnel({ payload })).pipe(
          Effect.map((state): TunnelReplaceResult => ({ _tag: 'Applied', state })),
          // The 409 body decodes to a `TunnelState` (the current snapshot);
          // {@link isTunnelState} distinguishes it from genuine errors
          // (HttpClientError / decode failures), which stay in the channel.
          Effect.catchIf(isTunnelState, (serverSnapshot) =>
            Effect.succeed<TunnelReplaceResult>({ _tag: 'Conflict', current: serverSnapshot })
          ),
          Effect.provide(buildTunnelAdminClientLayer())
        )
      )
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: TUNNEL_STATE_QUERY_KEY })
      const previous = queryClient.getQueryData<TunnelState>(TUNNEL_STATE_QUERY_KEY)
      if (previous !== undefined) {
        queryClient.setQueryData<TunnelState>(
          TUNNEL_STATE_QUERY_KEY,
          applyTunnelOptimistic(previous, input)
        )
      }
      return { previous }
    },
    onError: (_err, _input, context) => {
      if (context !== undefined && context.previous !== undefined) {
        queryClient.setQueryData<TunnelState>(TUNNEL_STATE_QUERY_KEY, context.previous)
      }
    },
    onSuccess: (result) => {
      // Adopt the authoritative snapshot the server returned: on `Applied`
      // the new state (bumped revision); on `Conflict` the current server
      // snapshot (newer revision, no write applied), which also discards
      // the optimistic projection.
      const snapshot = result._tag === 'Applied' ? result.state : result.current
      queryClient.setQueryData<TunnelState>(TUNNEL_STATE_QUERY_KEY, snapshot)
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: TUNNEL_STATE_QUERY_KEY })
    },
  })
}

export {
  applyTunnelOptimistic,
  buildReplacePayload,
  isTunnelState,
  TUNNEL_STATE_QUERY_KEY,
  tunnelStateQueryOptions,
  useTunnelReplaceMutation,
  useTunnelStateQuery,
}
export type { RelayInput, RunAuthed, TunnelReplaceInput, TunnelReplaceResult, TunnelState }
