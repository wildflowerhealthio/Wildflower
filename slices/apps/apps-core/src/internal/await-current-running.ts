import { Duration, Effect } from 'effect'
import { TunnelState, TunnelStore } from 'tunnel-core/livestore'

/**
 * Time the launch flow gives the tunnel daemon to flip
 * `TunnelState.running` to `true` after the launch handler commits
 * `requestedRunning: true` to `TunnelConfig`. Long enough to cover a
 * real localtunnel handshake (a few seconds) plus the daemon's own
 * `acquireRelease` round-trip; short enough that an SPA user gets a
 * useful fallback rather than an indefinite spinner.
 */
const DEFAULT_TUNNEL_LAUNCH_TIMEOUT: Duration.Duration = Duration.seconds(15)

/**
 * Snapshot of the running daemon's tunnel binding. Carried by
 * {@link TunnelLaunchOutcome} on the `kind: 'running'` branch. Mirrors
 * the relevant subset of `TunnelState.current$`'s value shape — the
 * launch handler only needs the `current*` fields to build a public
 * origin (`https://{subdomain}.{rootDomain}`).
 */
interface RunningTunnel {
  readonly currentSubdomain: string | null
  readonly currentRootDomain: string | null
  readonly currentLocalPort: number | null
}

/**
 * `LaunchApp`'s outcome when the tunnel state settles (or doesn't)
 * before the launch deadline. `kind: 'running'` means the daemon
 * reported `running: true` and `currentSubdomain` / `currentRootDomain`
 * are populated; `kind: 'timed-out'` means the daemon never flipped in
 * time and the caller should fall back to the local origin.
 */
type TunnelLaunchOutcome =
  | { readonly kind: 'running'; readonly state: RunningTunnel }
  | { readonly kind: 'timed-out' }

/**
 * Suspend until `TunnelState.queries.current$` reports `running: true`,
 * or {@link DEFAULT_TUNNEL_LAUNCH_TIMEOUT} elapses. The store is
 * subscribed through `store.subscribe`, disposing on success, timeout,
 * and interruption. Returns the resolved state on `running: true`, or
 * a `timed-out` tag the caller treats as "fall back to local origin".
 *
 * The launch handler commits `TunnelConfig.tunnelConfigSet({ requestedRunning: true })`
 * just before invoking this; the tunnel daemon (a long-lived fiber in
 * the host process — see `tunnel-core/daemon`) reacts to the config
 * change and flips `TunnelState.running` once the relay has bound. If
 * the daemon isn't running, or the relay refuses, the timeout fires
 * and the caller's redirect targets the local origin instead.
 */
const awaitCurrentRunning = (
  timeout: Duration.Duration = DEFAULT_TUNNEL_LAUNCH_TIMEOUT
): Effect.Effect<TunnelLaunchOutcome, never, TunnelStore> =>
  Effect.gen(function* () {
    const store = yield* TunnelStore
    return yield* Effect.async<TunnelLaunchOutcome>((resume) => {
      let disposed = false
      const dispose = store.subscribe(TunnelState.queries.current$, (state) => {
        if (disposed) return
        if (state.running) {
          disposed = true
          dispose()
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
        }
      })
      return Effect.sync(() => {
        if (!disposed) {
          disposed = true
          dispose()
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

export { awaitCurrentRunning, DEFAULT_TUNNEL_LAUNCH_TIMEOUT }
export type { RunningTunnel, TunnelLaunchOutcome }
