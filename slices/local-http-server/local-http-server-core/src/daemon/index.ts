import { Deferred, Effect, Exit, Scope, Stream, SynchronizedRef, pipe } from 'effect'
import { ServerState, LocalHttpServerStore } from 'local-http-server-core/livestore'

/**
 * Long-lived daemon Effect that drives the local HTTP server from
 * `LocalHttpServerStore.requestedRunning`:
 *
 *   - `requestedRunning: true` + no instance → fork `startServer(port, localOrigin)`
 *     into a sub-scope, await the bound signal, commit `{ running: true, port, localOrigin }`.
 *   - port/origin change while running → close the previous sub-scope and
 *     fork a fresh `startServer` for the new config.
 *   - `requestedRunning: false` + instance → close the sub-scope and commit
 *     `{ running: false, port: 8080 }` so the UI shows the idle default.
 *
 * The caller supplies the fully composed `startServer`. `startServer`
 * succeeds with `void` once the underlying server has bound its port — the
 * daemon uses that success as the "ready" signal — and is forked into the
 * sub-scope so any long-lived resources it acquires are released on scope
 * close.
 *
 * Transitions are serialised through a `SynchronizedRef`. On daemon scope
 * close any live sub-scope is torn down and a clean idle state is committed
 * so a future daemon process starts from defaults.
 */
const runHttpServerDaemon = <E>(
  startServer: (port: number, localOrigin: string) => Effect.Effect<void, E, never>
): Effect.Effect<void, never, Scope.Scope | LocalHttpServerStore> =>
  Effect.gen(function* () {
    const store = yield* LocalHttpServerStore

    // `subscribeStream` does not run the clientDocument's "ensure default
    // row exists" path that a synchronous `store.query` triggers, so
    // without this read the daemon's first stream emit returns an empty
    // result and the schema decoder dies on it. The query value is
    // discarded — the only purpose is the row-materialization side effect.
    yield* Effect.sync(() => store.query(ServerState.queries.current$))

    const httpServerRef = yield* SynchronizedRef.make<
      | { port: null; scope: null; localOrigin: null }
      | { port: number; scope: Scope.CloseableScope; localOrigin: string }
    >({ port: null, scope: null, localOrigin: null })

    // On daemon scope close: tear down any live sub-scope and commit a
    // clean idle state. State-resetting commits live at the daemon's
    // transition sites (here, and in the stop handler below) rather than
    // on the sub-scope finalizer, so reconfiguration can close the old
    // sub-scope without those commits cascading into the stream watcher.
    yield* Effect.addFinalizer(() =>
      SynchronizedRef.updateEffect(
        httpServerRef,
        ({
          scope,
        }): Effect.Effect<{ scope: null; port: null; localOrigin: null }, never, never> => {
          const closePrev = scope === null ? Effect.void : Scope.close(scope, Exit.void)
          return closePrev.pipe(
            Effect.tap(() =>
              Effect.sync(() =>
                store.commit(
                  ServerState.events.localHttpServerStateSet({
                    requestedRunning: false,
                    running: false,
                    port: 8080,
                  })
                )
              )
            ),
            Effect.as({ scope: null, port: null, localOrigin: null })
          )
        }
      )
    )

    const newHttpServer = (
      port: number,
      localOrigin: string
    ): Effect.Effect<
      { port: number; scope: Scope.CloseableScope; localOrigin: string },
      never,
      never
    > =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const portBound = yield* Deferred.make<void>()
        yield* pipe(
          startServer(port, localOrigin),
          // Signal the daemon once the server has bound to the port.
          Effect.tap(() => Deferred.succeed(portBound, undefined)),
          Effect.tapErrorCause((cause) =>
            Effect.logError('[local-http-server-expo] serverLayer failed', cause)
          ),
          // Run in the new HTTP server scope.
          Effect.forkIn(scope)
        )
        yield* Deferred.await(portBound)
        yield* Effect.sync(() =>
          store.commit(
            ServerState.events.localHttpServerStateSet({
              running: true,
              port,
              localOrigin,
            })
          )
        )
        return { port, scope, localOrigin }
      })

    const startStoreWatcher = store.subscribeStream(ServerState.queries.current$).pipe(
      Stream.runForEach(({ requestedRunning, port: requestedPort, localOrigin: requestedOrigin }) =>
        SynchronizedRef.updateEffect(httpServerRef, (runningState) => {
          const notRunning = runningState.scope === null
          const portChanged = requestedPort !== runningState.port
          const originChanged = requestedOrigin !== runningState.localOrigin
          if (requestedRunning && (notRunning || portChanged || originChanged)) {
            // Close any existing sub-scope first so the previous fork is
            // released when reconfiguring port/origin. The sub-scope
            // carries no state-resetting finalizer — `newHttpServer`'s
            // subsequent commit reflects the new config in one pass and
            // avoids cascading through the stream watcher.
            const closePrev =
              runningState.scope === null ? Effect.void : Scope.close(runningState.scope, Exit.void)
            return closePrev.pipe(
              Effect.flatMap(() => newHttpServer(requestedPort, requestedOrigin))
            )
          }
          if (!requestedRunning && runningState.scope !== null) {
            return Scope.close(runningState.scope, Exit.void).pipe(
              Effect.tap(() =>
                Effect.sync(() =>
                  store.commit(
                    ServerState.events.localHttpServerStateSet({
                      running: false,
                      // Reset to the idle default so the UI does not
                      // surface the previously-bound port as "current".
                      port: 8080,
                    })
                  )
                )
              ),
              Effect.as({ port: null, scope: null, localOrigin: null })
            )
          }

          return Effect.succeed(runningState)
        })
      )
    )
    yield* startStoreWatcher
  })

export { runHttpServerDaemon }
