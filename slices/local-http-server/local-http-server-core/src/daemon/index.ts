import { Cause, Data, Effect, Match, type Scope, Stream, pipe } from 'effect'
import {
  diffIntents,
  ensureDefaultRowExists,
  executeIntents,
  watchSnapshots,
} from 'shared-structures-core/process-daemon'

import { DEFAULT_IDLE_PORT, LocalHttpServerStore, ServerState } from '../livestore/index.ts'

/**
 * Long-lived daemon Effect that drives the local HTTP server from
 * `LocalHttpServerStore.requestedRunning`.
 *
 * @typeParam E - Error channel of the supplied `startServer`. Errors
 *   surface to the UI via the `error` field on `ServerState`; they do
 *   not propagate out of the daemon.
 * @param startServer - Stream that binds the listener and emits `void`
 *   when the port is bound (the daemon uses the first emit as the
 *   "ready" signal). The stream must keep running until either a
 *   terminal failure (post-bind crash → fails the stream) or
 *   interruption when the daemon swaps in a new config / stop intent.
 *   The daemon provides a `Scope.Scope` so the implementation can
 *   `Effect.acquireRelease` to tie its cleanup to the per-process scope.
 * @returns A scoped Effect that runs until its scope closes. The
 *   returned channel is `never` because all `startServer` failures
 *   (pre- and post-bind) are written to `ServerState.error` rather than
 *   thrown.
 *
 * @remarks
 *
 * Implementation is a three-stage stream pipeline from
 * `shared-structures-core/process-daemon`:
 *
 *  1. `watchSnapshots` subscribes to `ServerState.queries.current$`,
 *     projects each row down to `{requestedRunning, config}` (the
 *     user-controlled fields), and `Stream.changes`-dedupes consecutive
 *     identical projections — so the daemon's own commits to
 *     `running`/`error`/`port` don't re-trigger the pipeline.
 *  2. `diffIntents` folds consecutive snapshots into `StartOrReconfigure`
 *     / `Stop` transitions.
 *  3. `executeIntents` opens a per-process scope per StartOrReconfigure,
 *     peels the bind signal, and emits `LifecycleEvent`s. `{switch: true}`
 *     interrupts the previous process's tail when the next intent
 *     arrives — releasing the per-process scope via its
 *     `acquireRelease` finalizer.
 *
 * This slice's `Stream.runForEach` attaches the per-event livestore
 * commits. Pre- and post-bind failures share the same teardown patch
 * (running/port/error reset); the user's `requestedRunning` intent is
 * untouched here, so it survives across failures and daemon restarts.
 */
const runHttpServerDaemon = <E>(
  startServer: (config: { port: number; hostname: string }) => Stream.Stream<void, E, Scope.Scope>
): Effect.Effect<void, never, LocalHttpServerStore> =>
  Effect.gen(function* () {
    const store = yield* LocalHttpServerStore

    const commit = (
      patch: Partial<{
        readonly running: boolean
        readonly localOrigin: string
        readonly port: number
        readonly error: string | null
      }>
    ): Effect.Effect<void, never, never> =>
      Effect.sync(() => store.commit(ServerState.events.localHttpServerStateSet(patch)))

    const commitTeardown = (error: string | null): Effect.Effect<void, never, never> =>
      commit({ running: false, port: DEFAULT_IDLE_PORT, error })

    yield* ensureDefaultRowExists(store, ServerState.queries.current$)

    yield* pipe(
      watchSnapshots({
        store,
        query: ServerState.queries.current$,
        readSnapshot: (raw) => ({
          requestedRunning: raw.requestedRunning,
          config: Data.struct({ port: raw.port, localHostname: raw.localHostname }),
        }),
      }),
      diffIntents,
      executeIntents({
        startProcess: (cfg) => startServer({ port: cfg.port, hostname: cfg.localHostname }),
      }),
      Stream.runForEach((event) =>
        Match.value(event).pipe(
          Match.tag('Running', () => commit({ running: true, error: null })),
          Match.tag('Idle', () => commitTeardown(null)),
          Match.tag('Failed', ({ cause }) => commitTeardown(Cause.pretty(cause))),
          Match.exhaustive
        )
      )
    )
  })

export { runHttpServerDaemon }
