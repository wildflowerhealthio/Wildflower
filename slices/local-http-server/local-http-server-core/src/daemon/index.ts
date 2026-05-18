import { Cause, Deferred, Effect, Either, Exit, Scope, Stream, SynchronizedRef, pipe } from 'effect'

import { DEFAULT_IDLE_PORT, LocalHttpServerStore, ServerState } from '../livestore/index.ts'

type RunningState =
  | { readonly serverScope: null; readonly port: null; readonly localOrigin: null }
  | {
      readonly serverScope: Scope.CloseableScope
      readonly port: number
      readonly localOrigin: string
    }

const IDLE_STATE: RunningState = { serverScope: null, port: null, localOrigin: null }

/**
 * Long-lived daemon Effect that drives the local HTTP server from
 * `LocalHttpServerStore.requestedRunning`.
 *
 * @typeParam E - Error channel of the supplied `startServer`. Errors are
 *   logged and surfaced to the UI via the `error` field on
 *   `ServerState`; they do not propagate out of the daemon.
 * @param startServer - Effect that binds the listener. It must succeed
 *   with `void` once the port is bound (the daemon uses that success as
 *   the "ready" signal) and is forked into a sub-scope so any
 *   long-lived resources it acquires are released on scope close.
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
  startServer: (port: number, localOrigin: string) => Effect.Effect<void, E, never>
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
      SynchronizedRef.updateEffect(runningStateRef, ({ serverScope }) => {
        const closePrev = serverScope === null ? Effect.void : Scope.close(serverScope, Exit.void)
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
          startServer(port, localOrigin),
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
          return IDLE_STATE
        }

        // Re-asserting `requestedRunning: true` on every successful
        // start keeps the row in sync with the live state, even if a
        // caller toggled `requestedRunning: false` between the daemon's
        // stream tick and this commit.
        yield* commitState({
          requestedRunning: true,
          running: true,
          port,
          localOrigin,
          error: null,
        })
        return { serverScope, port, localOrigin }
      })

    const startStoreWatcher = store.subscribeStream(ServerState.queries.current$).pipe(
      Stream.runForEach(({ requestedRunning, port: requestedPort, localOrigin: requestedOrigin }) =>
        SynchronizedRef.updateEffect(runningStateRef, (runningState) => {
          const notRunning = runningState.serverScope === null
          const portChanged = requestedPort !== runningState.port
          const originChanged = requestedOrigin !== runningState.localOrigin
          if (requestedRunning && (notRunning || portChanged || originChanged)) {
            // Close any existing sub-scope first so the previous fork is
            // released when reconfiguring port/origin. The sub-scope
            // carries no state-resetting finalizer — `newHttpServer`'s
            // subsequent commit reflects the new config in one pass and
            // avoids cascading through the stream watcher.
            const closePrev =
              runningState.serverScope === null
                ? Effect.void
                : Scope.close(runningState.serverScope, Exit.void)
            return closePrev.pipe(
              Effect.flatMap(() => newHttpServer(requestedPort, requestedOrigin))
            )
          }
          if (!requestedRunning && runningState.serverScope !== null) {
            return Scope.close(runningState.serverScope, Exit.void).pipe(
              Effect.tap(() =>
                commitState({
                  running: false,
                  // Reset to the idle default so the UI does not surface
                  // the previously-bound port as "current".
                  port: DEFAULT_IDLE_PORT,
                })
              ),
              Effect.as(IDLE_STATE)
            )
          }

          return Effect.succeed(runningState)
        })
      )
    )
    yield* startStoreWatcher
  })

export { runHttpServerDaemon }
