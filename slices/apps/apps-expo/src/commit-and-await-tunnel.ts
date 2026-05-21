import { type Context, Duration, Effect, Schema } from 'effect'
import { TunnelConfig, TunnelState, type TunnelStore } from 'tunnel-core/livestore'

const TUNNEL_AWAIT_TIMEOUT: Duration.Duration = Duration.seconds(15)

/** Failure raised when the tunnel daemon never reports a bound origin. */
class TunnelTimedOut extends Schema.TaggedError<TunnelTimedOut>()('TunnelTimedOut', {
  timeoutMs: Schema.Number,
}) {}

type TunnelStoreService = Context.Tag.Service<typeof TunnelStore>

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

    // Snapshot first — livestore's `subscribe` fires synchronously with
    // the current value, so an already-bound tunnel resolves without
    // sitting in the async waiter.
    const current = tunnelStore.query(TunnelState.queries.current$)
    if (
      current.running &&
      current.currentSubdomain !== null &&
      current.currentRootDomain !== null
    ) {
      return `https://${current.currentSubdomain}.${current.currentRootDomain}`
    }

    return yield* Effect.async<string>((resume) => {
      let resumed = false
      const unsubscribe = tunnelStore.subscribe(TunnelState.queries.current$, (state) => {
        if (resumed || !state.running) return
        if (state.currentSubdomain === null || state.currentRootDomain === null) return
        resumed = true
        unsubscribe()
        resume(Effect.succeed(`https://${state.currentSubdomain}.${state.currentRootDomain}`))
      })
      return Effect.sync(() => {
        if (!resumed) {
          resumed = true
          unsubscribe()
        }
      })
    }).pipe(
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () => new TunnelTimedOut({ timeoutMs: Duration.toMillis(timeout) }),
      })
    )
  })

export { commitAndAwaitTunnel, TUNNEL_AWAIT_TIMEOUT, TunnelTimedOut }
export type { TunnelStoreService }
