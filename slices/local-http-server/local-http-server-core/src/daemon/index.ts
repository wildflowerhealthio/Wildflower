import { Deferred, Effect, Exit, Scope, Stream, SynchronizedRef, pipe } from 'effect'
import { ServerState, LocalHttpServerStore } from 'local-http-server-core/livestore'

/**
 * Long-lived daemon Effect that drives the local HTTP server from
 * `LocalHttpServerStore.requestedRunning`:
 *
 *   - `requestedRunning: true` + no instance → fork `startServer(port, localOrigin)`
 *     into a sub-scope, await port bind, commit `{ running: true, port, localOrigin }`.
 *   - `requestedRunning: false` + instance → close the sub-scope, which fires
 *     a finalizer that commits `{ running: false, port: undefined, localOrigin: undefined }`.
 *
 * The caller supplies the fully composed `startServer` — this daemon
 * knows nothing about gatekeeper, store wiring, telemetry, etc. It only
 * owns start/stop/port mechanics.
 *
 * Transitions are serialised through a `SynchronizedRef`. On daemon
 * scope close any live sub-scope is torn down too.
 */
const runHttpServerDaemon = <E>(
  startServer: (port: number, localOrigin: string) => Effect.Effect<never, E, never>
): Effect.Effect<void, never, Scope.Scope | LocalHttpServerStore> =>
  Effect.gen(function* () {
    const store = yield* LocalHttpServerStore

    const httpServerRef = yield* SynchronizedRef.make<
      | { port: null; scope: null; localOrigin: null }
      | { port: number; scope: Scope.CloseableScope; localOrigin: string }
    >({ port: null, scope: null, localOrigin: null })

    // Tear down any live sub-scope when the daemon scope itself closes.
    yield* Effect.addFinalizer(() =>
      SynchronizedRef.updateEffect(
        httpServerRef,
        ({
          scope,
        }): Effect.Effect<{ scope: null; port: null; localOrigin: null }, never, never> => {
          if (scope === null) {
            return Effect.succeed({ scope: null, port: null, localOrigin: null })
          } else {
            return Scope.close(scope, Exit.void).pipe(
              Effect.as({ scope: null, port: null, localOrigin: null })
            )
          }
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
          // Signal the daemon once the server has bound to the port
          Effect.tap(() => Deferred.succeed(portBound, undefined)),
          Effect.tapErrorCause((cause) =>
            Effect.logError('[local-http-server-expo] serverLayer failed', cause)
          ),
          // Run in the new HTTP server scope
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
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() =>
            store.commit(
              ServerState.events.localHttpServerStateSet({
                requestedRunning: false,
                running: false,
                port: 8080, // Default to 8080 when not running, to avoid "undefined" in the UI
                localOrigin,
              })
            )
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
            return newHttpServer(requestedPort, requestedOrigin)
          }
          if (!requestedRunning && runningState.scope !== null) {
            return Scope.close(runningState.scope, Exit.void).pipe(
              Effect.as({
                port: null,
                scope: null,
                localOrigin: null,
              })
            )
          }

          return Effect.succeed(runningState)
        })
      )
    )
    yield* startStoreWatcher
  })

export { runHttpServerDaemon }
