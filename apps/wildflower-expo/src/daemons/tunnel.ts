import type { Store } from '@livestore/livestore'
import { Duration, Effect, Schema } from 'effect'
import { TunnelConfig, TunnelState } from 'tunnel-core/livestore'
import type { schema } from '../livestore/schema.ts'

const TUNNEL_AWAIT_TIMEOUT: Duration.Duration = Duration.seconds(15)

/** Failure raised when the tunnel daemon never reports a bound origin. */
class TunnelTimedOut extends Schema.TaggedError<TunnelTimedOut>()('TunnelTimedOut', {
  timeoutMs: Schema.Number,
}) {}

/**
 * Flip `TunnelConfig.requestedRunning` and (when `active` is true) wait
 * for the tunnel daemon to settle `TunnelState`.
 *
 * The host-level `TunnelDaemon` (forked once at app boot) is what
 * actually opens / tears down the tunnel; this Effect only writes the
 * intent and observes the daemon's response.
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
 * Canonical `subdomain` / `rootDomain` / `localPort` were seeded into
 * `TunnelConfig` at first boot (see `livestore-store.ts`); we only
 * write `requestedRunning` here so user-customised values persist.
 */
const commitAndAwaitTunnel = (
  store: Store<typeof schema, object>,
  active: boolean,
  timeout: Duration.Duration = TUNNEL_AWAIT_TIMEOUT
): Effect.Effect<string | null, TunnelTimedOut> =>
  Effect.gen(function* () {
    yield* Effect.sync(() =>
      store.commit(TunnelConfig.events.tunnelConfigSet({ requestedRunning: active }))
    )
    if (!active) return null

    // Snapshot first — livestore's `subscribe` fires synchronously with
    // the current value, so an already-bound tunnel resolves without
    // sitting in the async waiter.
    const current = store.query(TunnelState.queries.current$)
    if (
      current.running &&
      current.currentSubdomain !== null &&
      current.currentRootDomain !== null
    ) {
      return `https://${current.currentSubdomain}.${current.currentRootDomain}`
    }

    return yield* Effect.async<string>((resume) => {
      let resumed = false
      const unsubscribe = store.subscribe(TunnelState.queries.current$, (state) => {
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
