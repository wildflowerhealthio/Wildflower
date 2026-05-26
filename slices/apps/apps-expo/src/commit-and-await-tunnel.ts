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

/**
 * Narrowed `TunnelState` row that the host's reply can build an origin
 * from: `running` is true and both domain fields are non-null. Produced
 * by {@link isReadyTunnelState} and consumed by the format-as-URL step
 * below — `currentSubdomain` and `currentRootDomain` are `string` here,
 * not `string | null`, so the URL composition needs no extra guard.
 */
type ReadyTunnelStateRow = TunnelStateRow & {
  readonly running: true
  readonly currentSubdomain: string
  readonly currentRootDomain: string
}

const isReadyTunnelState = (s: TunnelStateRow): s is ReadyTunnelStateRow =>
  s.running && s.currentSubdomain !== null && s.currentRootDomain !== null

/**
 * Flip `TunnelConfig.requestedRunning` and (when `active` is true) wait
 * for the tunnel daemon to settle `TunnelState`.
 *
 * The host-level tunnel daemon is what actually opens / tears down the
 * tunnel; this Effect only writes the intent and observes the daemon's
 * response.
 *
 *  - `active === true`: commit `requestedRunning: true`, then succeed
 *    with `https://{currentSubdomain}.{currentRootDomain}` once
 *    `TunnelState.running` is true and both domain fields are non-null.
 *    Fails with {@link TunnelTimedOut} if neither happens within the
 *    timeout.
 *  - `active === false`: commit `requestedRunning: false` and succeed
 *    with `null` immediately — the daemon will tear the tunnel down on
 *    its own schedule, but callers don't wait for it.
 *
 * Takes the resolved `TunnelStore` service directly rather than
 * yielding it from context so the helper composes inside bridge
 * handlers, whose declared signature is `Effect<void, never, never>`.
 *
 * The snapshot-then-subscribe-then-unsubscribe inner loop lives in
 * `shared-structures-core/livestore`'s {@link subscribeUntil}; this
 * helper diverges from `apps-core/internal/await-tunnel-running.ts` in
 * two intentional places: the predicate is stricter (both
 * `currentSubdomain` and `currentRootDomain` must be non-null, since
 * the host's reply needs a usable origin) and the timeout surfaces a
 * tagged error instead of a tagged outcome.
 */
const commitAndAwaitTunnel = (
  tunnelStore: TunnelStoreService,
  active: boolean,
  timeout: Duration.Duration = TUNNEL_AWAIT_TIMEOUT
): Effect.Effect<string | null, TunnelTimedOut> =>
  Effect.gen(function* () {
    yield* Effect.sync(() =>
      tunnelStore.commit(TunnelConfig.events.tunnelConfigSet({ requestedRunning: active }))
    )
    if (!active) return null

    // `subscribeUntil`'s refinement overload narrows the result to
    // `ReadyTunnelStateRow`, so the URL composition below needs no
    // null check or runtime guard. Dropping a `!== null` clause from
    // `isReadyTunnelState` would change the return type and break the
    // template literal at compile time.
    const state = yield* subscribeUntil(
      tunnelStore,
      TunnelState.queries.current$,
      isReadyTunnelState
    ).pipe(
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () => new TunnelTimedOut({ timeoutMs: Duration.toMillis(timeout) }),
      })
    )
    return `https://${state.currentSubdomain}.${state.currentRootDomain}`
  })

export { commitAndAwaitTunnel, TUNNEL_AWAIT_TIMEOUT, TunnelTimedOut }
export type { ReadyTunnelStateRow, TunnelStateRow, TunnelStoreService }
