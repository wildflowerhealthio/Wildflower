import {
  Cause,
  Deferred,
  Effect,
  Either,
  Exit,
  Match,
  Scope,
  Stream,
  SynchronizedRef,
  pipe,
} from 'effect'

import { DEFAULT_IDLE_PORT, LocalHttpServerStore, ServerState } from '../livestore/index.ts'

type RunningState =
  | { readonly _tag: 'Idle' }
  /**
   * A start attempt for `(port, localOrigin)` failed. The daemon
   * remembers the failed config so it won't busy-retry on the
   * error-commit's own stream tick — only a config change (different
   * port/origin) or a `requestedRunning: false` toggle re-arms it.
   */
  | { readonly _tag: 'Failed'; readonly port: number; readonly localOrigin: string }
  | {
      readonly _tag: 'Running'
      readonly serverScope: Scope.CloseableScope
      readonly port: number
      readonly localOrigin: string
    }

const IDLE_STATE: RunningState = { _tag: 'Idle' }

/**
 * Intent derived from a stream tick: what does the daemon need to do
 * given the requested state and the current sub-scope? Lifting this out
 * of the `if`-chain makes the state-machine branches explicit and lets
 * `Match.exhaustive` catch a missed case at compile time.
 */
type Intent =
  | {
      readonly _tag: 'StartOrReconfigure'
      readonly prev: Scope.CloseableScope | null
      readonly port: number
      readonly localOrigin: string
    }
  | { readonly _tag: 'Stop'; readonly prev: Scope.CloseableScope | null }
  | { readonly _tag: 'NoOp'; readonly runningState: RunningState }

const sameConfig = (
  runningState: RunningState,
  requestedPort: number,
  requestedOrigin: string
): boolean =>
  runningState._tag !== 'Idle' &&
  runningState.port === requestedPort &&
  runningState.localOrigin === requestedOrigin

const computeIntent = (
  runningState: RunningState,
  requestedRunning: boolean,
  requestedPort: number,
  requestedOrigin: string
): Intent => {
  if (requestedRunning && !sameConfig(runningState, requestedPort, requestedOrigin)) {
    return {
      _tag: 'StartOrReconfigure',
      prev: runningState._tag === 'Running' ? runningState.serverScope : null,
      port: requestedPort,
      localOrigin: requestedOrigin,
    }
  }
  if (!requestedRunning && runningState._tag !== 'Idle') {
    // Failed → Stop closes no scope (it was already closed at the
    // failure site) but still needs to commit the running=false /
    // idle-port reset so the UI clears the failed state and the
    // daemon re-arms for a future start.
    return {
      _tag: 'Stop',
      prev: runningState._tag === 'Running' ? runningState.serverScope : null,
    }
  }
  return { _tag: 'NoOp', runningState }
}

/**
 * Long-lived daemon Effect that drives the local HTTP server from
 * `LocalHttpServerStore.requestedRunning`.
 *
 * @typeParam E - Error channel of the supplied `startServer`. Errors are
 *   logged and surfaced to the UI via the `error` field on
 *   `ServerState`; they do not propagate out of the daemon.
 * @param startServer - Effect that binds the listener. It must succeed
 *   with `void` once the port is bound (the daemon uses that success as
 *   the "ready" signal). The daemon forks it into a sub-scope and
 *   provides that `Scope.Scope` as a context — long-running listeners
 *   should `Effect.acquireRelease` to register their cleanup with the
 *   sub-scope so it fires when the daemon closes it (on reconfigure or
 *   when `requestedRunning` flips back to false).
 * @returns A scoped Effect that runs until its scope closes. The
 *   returned channel is `never` because all `startServer` failures are
 *   written to `ServerState.error` rather than thrown.
 *
 * @remarks
 *
 * Transitions:
 * - `requestedRunning: true` + no instance → fork `startServer(port, localOrigin)`
 *   into a sub-scope, await the bound signal, commit
 *   `{ requestedRunning: true, running: true, port, localOrigin, error: null }`.
 * - port/origin change while running → close the previous sub-scope and
 *   fork a fresh `startServer` for the new config.
 * - `requestedRunning: false` + instance → close the sub-scope and
 *   commit `{ running: false }`.
 * - `startServer` failure before bind → commit
 *   `{ running: false, error: <cause> }` with `requestedRunning` left at
 *   the user's intent.
 *
 * Transitions are serialised through a `SynchronizedRef`. State-resetting
 * commits live at the daemon's transition sites rather than on the
 * sub-scope finalizer, so reconfiguration can close the old sub-scope
 * without those commits cascading into the stream watcher. The daemon
 * scope close tears down any live sub-scope but does not touch the row —
 * the user's `requestedRunning` intent must survive across daemon
 * restarts.
 */
const runHttpServerDaemon = <E>(
  startServer: (port: number, localOrigin: string) => Effect.Effect<void, E, Scope.Scope>
): Effect.Effect<void, never, Scope.Scope | LocalHttpServerStore> =>
  Effect.gen(function* () {
    const store = yield* LocalHttpServerStore

    const commitState = (
      patch: Partial<{
        readonly requestedRunning: boolean
        readonly running: boolean
        readonly localOrigin: string
        readonly port: number
        readonly error: string | null
      }>
    ): Effect.Effect<void, never, never> =>
      Effect.sync(() => store.commit(ServerState.events.localHttpServerStateSet(patch)))

    // WORKAROUND(livestore): `subscribeStream` does not run the
    // clientDocument's "ensure default row exists" path that a
    // synchronous `store.query` triggers, so without this read the
    // daemon's first stream emit returns an empty result and the schema
    // decoder dies on it. The query value is discarded — the only
    // purpose is the row-materialization side effect.
    yield* Effect.sync(() => store.query(ServerState.queries.current$))

    const runningStateRef = yield* SynchronizedRef.make<RunningState>(IDLE_STATE)

    // On daemon scope close: tear down any live sub-scope. Leave the
    // row alone — `requestedRunning` represents the user's intent and
    // must survive across daemon restarts.
    yield* Effect.addFinalizer(() =>
      SynchronizedRef.updateEffect(runningStateRef, (state) => {
        const closePrev =
          state._tag === 'Running' ? Scope.close(state.serverScope, Exit.void) : Effect.void
        return closePrev.pipe(Effect.as(IDLE_STATE))
      })
    )

    const newHttpServer = (
      port: number,
      localOrigin: string
    ): Effect.Effect<RunningState, never, never> =>
      Effect.gen(function* () {
        const serverScope = yield* Scope.make()
        const portBound = yield* Deferred.make<void, E>()
        yield* pipe(
          // Extend the daemon's sub-scope into `startServer` (rather than
          // letting `forkIn` strip its Scope requirement) so any
          // `Effect.acquireRelease` inside `startServer` ties its release
          // to `serverScope` — the release fires when the daemon closes
          // the scope on reconfigure or stop, not when the bind-success
          // signal lands.
          Scope.extend(startServer(port, localOrigin), serverScope),
          Effect.tap(() => Deferred.succeed(portBound, undefined)),
          Effect.tapErrorCause((cause) =>
            pipe(
              Deferred.failCause<void, E>(portBound, cause),
              Effect.zipRight(Effect.logError('[local-http-server-core] startServer failed', cause))
            )
          ),
          Effect.forkIn(serverScope)
        )

        const bindResult = yield* Effect.either(Deferred.await(portBound))
        if (Either.isLeft(bindResult)) {
          yield* Scope.close(serverScope, Exit.void)
          yield* commitState({
            running: false,
            error: Cause.pretty(Cause.fail(bindResult.left)),
          })
          // Remember the failed (port, origin) so the error-commit's own
          // stream tick lands as a `NoOp` rather than triggering a
          // busy-retry — `requestedRunning: true` is still in the row
          // after the failure, so without this guard `sameConfig` would
          // return false and the daemon would loop forever.
          return { _tag: 'Failed', port, localOrigin } as const
        }

        // The daemon owns `running` and `error`; `requestedRunning`,
        // `port`, and `localOrigin` are user intent and must not be
        // echoed back here — doing so would overwrite a concurrent
        // user update committed while the daemon was binding (the
        // overwrite then disappears from the stream queue and the
        // daemon never reconfigures).
        yield* commitState({ running: true, error: null })
        return { _tag: 'Running', serverScope, port, localOrigin } as const
      })

    const startStoreWatcher = store.subscribeStream(ServerState.queries.current$).pipe(
      // The stream emits a snapshot per commit, but during a long
      // `newHttpServer` (fork + await bind + commit) the next emissions
      // queue up. Draining them in order would replay stale snapshots
      // (including the daemon's own past commits) and chase configs
      // that no longer match the row. Treat each emission only as a
      // "something changed, go look" signal and read the latest state
      // synchronously inside the serialized update.
      Stream.runForEach(() =>
        SynchronizedRef.updateEffect(runningStateRef, (runningState) => {
          const {
            requestedRunning,
            port: requestedPort,
            localOrigin: requestedOrigin,
          } = store.query(ServerState.queries.current$)
          const intent = computeIntent(
            runningState,
            requestedRunning,
            requestedPort,
            requestedOrigin
          )
          return Match.value(intent).pipe(
            Match.tag('StartOrReconfigure', ({ prev, port, localOrigin }) => {
              // Close any existing sub-scope first so the previous fork
              // is released when reconfiguring port/origin. The
              // sub-scope carries no state-resetting finalizer —
              // `newHttpServer`'s subsequent commit reflects the new
              // config in one pass and avoids cascading through the
              // stream watcher.
              const closePrev = prev === null ? Effect.void : Scope.close(prev, Exit.void)
              return closePrev.pipe(Effect.flatMap(() => newHttpServer(port, localOrigin)))
            }),
            Match.tag('Stop', ({ prev }) => {
              const closePrev = prev === null ? Effect.void : Scope.close(prev, Exit.void)
              return closePrev.pipe(
                Effect.tap(() =>
                  commitState({
                    running: false,
                    // Reset to the idle default so the UI does not
                    // surface the previously-bound port as "current".
                    port: DEFAULT_IDLE_PORT,
                    // Clear the previous failure so the UI is not
                    // stuck on a stale error after the user toggles
                    // requestedRunning back off.
                    error: null,
                  })
                ),
                Effect.as(IDLE_STATE)
              )
            }),
            Match.tag('NoOp', ({ runningState: state }) => Effect.succeed(state)),
            Match.exhaustive
          )
        })
      )
    )
    yield* startStoreWatcher
  })

export { runHttpServerDaemon }
