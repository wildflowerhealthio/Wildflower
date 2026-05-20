import { Duration, Effect } from 'effect'
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

type TunnelLaunchOutcome =
  | { readonly kind: 'running'; readonly state: RunningTunnel }
  | { readonly kind: 'timed-out' }

/**
 * Suspend until `TunnelState.queries.current$` reports `running: true`,
 * or `timeout` elapses. Callers commit
 * `TunnelConfig.tunnelConfigSet({ requestedRunning: true })` first; the
 * tunnel daemon flips `running` once the relay has bound. On timeout
 * (or if the daemon never reports a bound origin) the caller should
 * fall back to its local origin.
 */
const awaitTunnelRunning = (
  timeout: Duration.Duration = DEFAULT_TUNNEL_LAUNCH_TIMEOUT
): Effect.Effect<TunnelLaunchOutcome, never, TunnelStore> =>
  Effect.gen(function* () {
    const store = yield* TunnelStore

    // Snapshot first — livestore's `subscribe` fires its callback
    // synchronously with the current value, which would otherwise reach
    // `unsubscribe()` while that binding is in its temporal dead zone.
    const current = store.query(TunnelState.queries.current$)
    if (current.running) {
      return {
        kind: 'running',
        state: {
          currentSubdomain: current.currentSubdomain,
          currentRootDomain: current.currentRootDomain,
          currentLocalPort: current.currentLocalPort,
        },
      } satisfies TunnelLaunchOutcome
    }

    return yield* Effect.async<TunnelLaunchOutcome>((resume) => {
      let resumed = false
      const unsubscribe = store.subscribe(TunnelState.queries.current$, (state) => {
        if (resumed || !state.running) return
        resumed = true
        unsubscribe()
        resume(
          Effect.succeed<TunnelLaunchOutcome>({
            kind: 'running',
            state: {
              currentSubdomain: state.currentSubdomain,
              currentRootDomain: state.currentRootDomain,
              currentLocalPort: state.currentLocalPort,
            },
          })
        )
      })
      return Effect.sync(() => {
        if (!resumed) {
          resumed = true
          unsubscribe()
        }
      })
    }).pipe(
      Effect.timeoutTo({
        duration: timeout,
        onTimeout: (): TunnelLaunchOutcome => ({ kind: 'timed-out' }),
        onSuccess: (outcome): TunnelLaunchOutcome => outcome,
      })
    )
  })

export { awaitTunnelRunning, DEFAULT_TUNNEL_LAUNCH_TIMEOUT }
export type { RunningTunnel, TunnelLaunchOutcome }
