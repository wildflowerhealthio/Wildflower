import { Duration, Effect, Schema } from 'effect'
import { subscribeUntil } from 'shared-structures-core/livestore'
import { TunnelState, TunnelStore } from 'tunnel-core/livestore'

/**
 * Default deadline for the launch flow's tunnel wait — long enough for
 * a real localtunnel handshake, short enough that an SPA user gets a
 * fallback rather than an indefinite spinner.
 */
const DEFAULT_TUNNEL_LAUNCH_TIMEOUT: Duration.Duration = Duration.seconds(15)

/** Snapshot of the daemon's tunnel binding when `running: true`. */
interface RunningTunnel {
  readonly currentSubdomain: string | null
  readonly currentRootDomain: string | null
  readonly currentLocalPort: number | null
}

/**
 * Failure raised by {@link awaitTunnelRunning} when the daemon never
 * reports `running: true` within the caller-supplied deadline. Modelled
 * as a tagged error rather than a tagged success branch so callers can
 * recover with `Effect.catchTag('TunnelLaunchTimedOut', …)` or
 * `Effect.either` and keep their happy-path types narrow.
 */
class TunnelLaunchTimedOut extends Schema.TaggedError<TunnelLaunchTimedOut>()(
  'TunnelLaunchTimedOut',
  { timeoutMs: Schema.Number }
) {}

/**
 * Suspend until `TunnelState.queries.current$` reports `running: true`,
 * or `timeout` elapses. Callers commit
 * `TunnelConfig.tunnelConfigSet({ requestedRunning: true })` first; the
 * tunnel daemon flips `running` once the relay has bound. On timeout
 * (or if the daemon never reports a bound origin) the caller should
 * recover (e.g. fall back to its local origin) via the tagged
 * {@link TunnelLaunchTimedOut} error.
 *
 * @remarks
 * `requestedRunning` is a sticky request, not a per-call lease.
 * Interrupting this Effect (the caller's HTTP handler is cancelled
 * mid-wait, etc.) does NOT roll back the commit — the daemon is the
 * single source of truth for the tunnel's lifecycle, and a concurrent
 * caller may still need it up. The interrupted caller drops out; the
 * daemon reconciles on its own schedule.
 *
 * The snapshot-then-subscribe-then-unsubscribe inner loop lives in
 * `shared-structures-core/livestore`'s {@link subscribeUntil}. This
 * helper picks the predicate (`running: true`), the projection from
 * the full state row to the {@link RunningTunnel} subset the caller
 * needs, and the {@link TunnelLaunchTimedOut} error the timeout
 * surfaces.
 */
const awaitTunnelRunning = (
  timeout: Duration.Duration = DEFAULT_TUNNEL_LAUNCH_TIMEOUT
): Effect.Effect<RunningTunnel, TunnelLaunchTimedOut, TunnelStore> =>
  Effect.gen(function* () {
    const store = yield* TunnelStore
    return yield* subscribeUntil(store, TunnelState.queries.current$, (s) => s.running).pipe(
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () => new TunnelLaunchTimedOut({ timeoutMs: Duration.toMillis(timeout) }),
      }),
      Effect.map(
        (state): RunningTunnel => ({
          currentSubdomain: state.currentSubdomain,
          currentRootDomain: state.currentRootDomain,
          currentLocalPort: state.currentLocalPort,
        })
      )
    )
  })

export { awaitTunnelRunning, DEFAULT_TUNNEL_LAUNCH_TIMEOUT, TunnelLaunchTimedOut }
export type { RunningTunnel }
