// The snapshot-then-subscribe-then-unsubscribe inner loop lives in
// `shared-structures-core/livestore`'s `subscribeUntil`; this file
// intentionally diverges from `apps-core/internal/await-tunnel-running.ts`
// in two places: the predicate is stricter (both `currentSubdomain` and
// `currentRootDomain` must be non-null, since the host's reply needs a
// usable origin) and the timeout surfaces a tagged error instead of a
// tagged outcome.
import type { Queryable } from '@livestore/livestore'
import { type Context, Duration, Effect, Schema } from 'effect'
import { subscribeUntil } from 'shared-structures-core/livestore'
import { TunnelConfig, TunnelState, type TunnelStore } from 'tunnel-core/livestore'

const TUNNEL_AWAIT_TIMEOUT: Duration.Duration = Duration.seconds(15)

/** Failure raised when the tunnel daemon never reports a bound origin. */
class TunnelTimedOut extends Schema.TaggedError<TunnelTimedOut>()('TunnelTimedOut', {
  timeoutMs: Schema.Number,
}) {}

type TunnelStoreService = Context.Tag.Service<typeof TunnelStore>

/** Shape of `TunnelState.queries.current$`'s emitted snapshot. */
type TunnelStateRow = Queryable.Result<typeof TunnelState.queries.current$>

/** Narrowed `TunnelStateRow`: running with both domain fields non-null. */
type ReadyTunnelStateRow = TunnelStateRow & {
  readonly running: true
  readonly currentSubdomain: string
  readonly currentRootDomain: string
}

const isReadyTunnelState = (s: TunnelStateRow): s is ReadyTunnelStateRow =>
  s.running && s.currentSubdomain !== null && s.currentRootDomain !== null

/**
 * Commit `TunnelConfig.requestedRunning` so the host-level tunnel daemon
 * knows whether to bring the tunnel up or take it down. Doesn't wait
 * for the daemon — pair with {@link awaitTunnelOrigin} when the caller
 * needs the resulting origin.
 *
 * Takes the resolved `TunnelStore` service directly rather than yielding
 * it from context so the helper composes inside bridge handlers, whose
 * declared signature is `Effect<void, never, never>`.
 */
const commitRequestedRunning = (
  tunnelStore: TunnelStoreService,
  active: boolean
): Effect.Effect<void> =>
  Effect.sync(() =>
    tunnelStore.commit(TunnelConfig.events.tunnelConfigSet({ requestedRunning: active }))
  )

/**
 * Wait for `TunnelState` to settle into a ready row (running + both
 * domain fields non-null), then return `https://{sub}.{root}`. Fails
 * with {@link TunnelTimedOut} if the daemon never settles within
 * `timeout`. The `subscribeUntil` refinement overload narrows the row
 * to {@link ReadyTunnelStateRow}, so the URL composition needs no
 * additional null check.
 */
const awaitTunnelOrigin = (
  tunnelStore: TunnelStoreService,
  timeout: Duration.Duration = TUNNEL_AWAIT_TIMEOUT
): Effect.Effect<string, TunnelTimedOut> =>
  subscribeUntil(tunnelStore, TunnelState.queries.current$, isReadyTunnelState).pipe(
    Effect.timeoutFail({
      duration: timeout,
      onTimeout: () => new TunnelTimedOut({ timeoutMs: Duration.toMillis(timeout) }),
    }),
    Effect.map((state) => `https://${state.currentSubdomain}.${state.currentRootDomain}`)
  )

export { awaitTunnelOrigin, commitRequestedRunning, TunnelTimedOut }
export type { ReadyTunnelStateRow, TunnelStateRow, TunnelStoreService }
