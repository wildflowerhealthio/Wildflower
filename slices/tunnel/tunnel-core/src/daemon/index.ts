import { Cause, Data, Effect, Match, type Scope, Stream, pipe } from 'effect'
import {
  diffIntents,
  ensureDefaultRowExists,
  executeIntents,
  watchSnapshots,
} from 'shared-structures-core/process-daemon'

import { TunnelConfig, TunnelState, TunnelStore } from '../livestore/index.ts'

interface ResolvedConfig {
  readonly subdomain: string
  readonly rootDomain: string
  readonly localPort: number
}

/**
 * What the tunnel actually resolved to — written to
 * `TunnelState.currentSubdomain` / `currentRootDomain` by the daemon
 * once `startTunnel` succeeds. Mirrors the requested `ResolvedConfig`
 * minus `localPort` (purely local; not negotiated with the relay), and
 * can differ from the requested values when the relay redirects to a
 * different subdomain or rootDomain.
 */
interface DomainResult {
  readonly subdomain: string
  readonly rootDomain: string
}

/**
 * Long-lived daemon Effect that drives the tunnel from
 * `TunnelConfig.requestedEnabled` + `subdomain` + `rootDomain` +
 * `localPort`.
 *
 * @typeParam E - Error channel of the supplied `startTunnel`. Errors
 *   surface to the UI via `TunnelState.error`; they do not propagate
 *   out of the daemon.
 * @param startTunnel - Stream that opens the tunnel and emits
 *   `DomainResult` values over its lifetime. The first emit is the
 *   "tunnel up" signal (the daemon commits `currentEnabled: true` and
 *   writes the granted subdomain/rootDomain); subsequent emits update
 *   the granted values in place (e.g. relay reconnects to a new
 *   subdomain). The stream must keep running until either a terminal
 *   failure (post-bind cluster error → fails the stream) or
 *   interruption when the daemon swaps in a new config / stop intent.
 *   The daemon provides a `Scope.Scope` so the implementation can
 *   `Effect.acquireRelease` to tie its cleanup to the per-process scope.
 * @returns A scoped Effect that runs until its scope closes. The error
 *   channel is `never` because all `startTunnel` failures (pre- and
 *   post-bind) are written to `TunnelState.error` rather than thrown.
 *
 * @remarks
 *
 * Implementation is a three-stage stream pipeline from
 * `shared-structures-core/process-daemon`:
 *
 *  1. `watchSnapshots` subscribes to `TunnelConfig.queries.current$`,
 *     projects each row down to `{requestedRunning, config}` (mapping
 *     `requestedEnabled` → `requestedRunning` and parking when any of
 *     `subdomain`/`rootDomain`/`localPort` is null), and
 *     `Stream.changes`-dedupes consecutive identical projections.
 *  2. `diffIntents` folds consecutive snapshots into `StartOrReconfigure`
 *     / `Stop` transitions.
 *  3. `executeIntents` opens a per-process scope per StartOrReconfigure,
 *     peels the bind signal, and emits `LifecycleEvent`s. `{switch: true}`
 *     interrupts the previous tunnel's tail when the next intent
 *     arrives.
 *
 * This slice's `Stream.runForEach` attaches the per-event livestore
 * commits. `Running` commits the granted `DomainResult` plus the requested
 * `localPort` into `TunnelState`; tunnel re-binds (relay reconnects to a
 * different subdomain) surface as `Running`s.
 */
const runTunnelDaemon = <E>(
  startTunnel: (config: ResolvedConfig) => Stream.Stream<DomainResult, E, Scope.Scope>
): Effect.Effect<void, never, TunnelStore> =>
  Effect.gen(function* () {
    const store = yield* TunnelStore

    const commit = (
      patch: Partial<{
        readonly currentEnabled: boolean
        readonly currentSubdomain: string | null
        readonly currentRootDomain: string | null
        readonly currentLocalPort: number | null
        readonly error: string | null
      }>
    ): Effect.Effect<void, never, never> =>
      Effect.sync(() => store.commit(TunnelState.events.tunnelStateSet(patch)))

    const commitRunning = (
      result: DomainResult,
      localPort: number
    ): Effect.Effect<void, never, never> =>
      commit({
        currentEnabled: true,
        currentSubdomain: result.subdomain,
        currentRootDomain: result.rootDomain,
        currentLocalPort: localPort,
        error: null,
      })

    const commitTeardown = (error: string | null): Effect.Effect<void, never, never> =>
      commit({
        currentEnabled: false,
        currentSubdomain: null,
        currentRootDomain: null,
        currentLocalPort: null,
        error,
      })

    // Materialize the session-state default row up front — same workaround
    // local-http-server-core uses. The persistent `TunnelConfig` table
    // doesn't need it (no default row; daemon treats "absent" as "nothing
    // to do" via the readSnapshot projection below).
    yield* ensureDefaultRowExists(store, TunnelState.queries.current$)

    yield* pipe(
      watchSnapshots({
        store,
        query: TunnelConfig.queries.current$,
        readSnapshot: (raw: TunnelConfig.TunnelConfigRow | undefined) => {
          if (raw === undefined) return { requestedRunning: false, config: null }
          const { requestedEnabled, subdomain, rootDomain, localPort } = raw
          if (subdomain === null || rootDomain === null || localPort === null) {
            return { requestedRunning: requestedEnabled, config: null }
          }
          return {
            requestedRunning: requestedEnabled,
            config: Data.struct({ subdomain, rootDomain, localPort }),
          }
        },
      }),
      diffIntents,
      executeIntents({ startProcess: startTunnel }),
      Stream.runForEach((event) =>
        Match.value(event).pipe(
          Match.tag('Running', ({ config, status }) => commitRunning(status, config.localPort)),
          Match.tag('Idle', () => commitTeardown(null)),
          Match.tag('Failed', ({ cause }) => commitTeardown(Cause.pretty(cause))),
          Match.exhaustive
        )
      )
    )
  })

export { runTunnelDaemon }
export type { DomainResult, ResolvedConfig }
