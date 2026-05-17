import { Deferred, Effect, Exit, Layer, Scope, Stream, SynchronizedRef } from 'effect'
import { LocalHttpServerStore, Port } from 'local-http-server-core/contexts'
import { ServerState } from 'local-http-server-core/livestore'

/**
 * Long-lived daemon Effect that drives the local HTTP server from
 * `LocalHttpServerStore.requestedRunning`:
 *
 *   - `requestedRunning: true` + no instance → fork `Layer.launch(serverLayer)`
 *     into a sub-scope, await port bind, commit `{ running: true, port, localOrigin }`.
 *   - `requestedRunning: false` + instance → close the sub-scope, which fires
 *     a finalizer that commits `{ running: false, port: undefined, localOrigin: undefined }`.
 *
 * The caller supplies the fully composed `serverLayer` — this daemon
 * knows nothing about gatekeeper, store wiring, telemetry, etc. It only
 * owns start/stop/port mechanics.
 *
 * Transitions are serialised through a `SynchronizedRef`. On daemon
 * scope close any live sub-scope is torn down too.
 */
const runHttpServer = <E>(
  serverLayer: Layer.Layer<never, E, never>
): Effect.Effect<void, never, Scope.Scope | Port | LocalHttpServerStore> =>
  Effect.gen(function* () {
    const port = yield* Port
    const store = yield* LocalHttpServerStore
    const localOrigin = `http://127.0.0.1:${port}`

    const instanceRef = yield* SynchronizedRef.make<Scope.CloseableScope | null>(null)

    // Tear down any live sub-scope when the daemon scope itself closes.
    yield* Effect.addFinalizer(() =>
      SynchronizedRef.updateEffect(instanceRef, (current) =>
        current === null
          ? Effect.succeed(null)
          : Scope.close(current, Exit.void).pipe(Effect.as(null))
      )
    )

    const startInstance: Effect.Effect<Scope.CloseableScope, never, never> = Effect.gen(
      function* () {
        const subScope = yield* Scope.make()
        const portBound = yield* Deferred.make<void>()
        const tappedLayer = serverLayer.pipe(
          Layer.tap(() => Deferred.succeed(portBound, undefined))
        )
        yield* Effect.forkIn(
          Layer.launch(tappedLayer).pipe(
            Effect.tapErrorCause((cause) =>
              Effect.logError('[local-http-server-expo] serverLayer failed', cause)
            )
          ),
          subScope
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
          subScope,
          Effect.sync(() =>
            store.commit(
              ServerState.events.localHttpServerStateSet({
                running: false,
                port: null,
                localOrigin: null,
              })
            )
          )
        )
        return subScope
      }
    )

    return yield* store.subscribeStream(ServerState.queries.current$).pipe(
      Stream.runForEach(({ requestedRunning }) =>
        SynchronizedRef.updateEffect(instanceRef, (current) => {
          if (requestedRunning && current === null) return startInstance
          if (!requestedRunning && current !== null) {
            return Scope.close(current, Exit.void).pipe(Effect.as(null))
          }
          return Effect.succeed(current)
        })
      )
    )
  })

export { runHttpServer }
