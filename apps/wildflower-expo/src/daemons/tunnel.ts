import { Effect, Exit, Scope, Stream, SynchronizedRef } from 'effect'
import { LocalHttpServerStore, ServerState } from 'local-http-server-core/livestore'
import { TUNNEL_SUBDOMAIN } from 'tunnel-core/canonical-url'
import { TunnelState, TunnelStore } from 'tunnel-core/livestore'
import * as TunnelExpo from 'tunnel-expo'

interface Instance {
  readonly requestedFor: string
  readonly scope: Scope.CloseableScope
}

interface Decision {
  readonly requested: string | null
  readonly serverReady: boolean
  readonly port: number | null
  readonly localOrigin: string | null
}

/**
 * Tunnel daemon. Watches `TunnelStore.requestedPublicOrigin` together
 * with `LocalHttpServerStore.running` / `localOrigin` / `port` and:
 *
 *   - opens a scope and calls `TunnelExpo.acquire` once both
 *     "requested" and "server running" are true,
 *   - commits `currentPublicOrigin` if (and only if) the granted URL
 *     matches the requested URL exactly — anything else logs a warning
 *     and leaves `currentPublicOrigin` undefined,
 *   - tears the tunnel down + clears `currentPublicOrigin` when the
 *     request is cleared, the server stops, or the request URL changes.
 *
 * State transitions are serialised through a `SynchronizedRef`. On
 * daemon scope close, any live tunnel scope is torn down too.
 */
const tunnelDaemon = (): Effect.Effect<
  void,
  never,
  Scope.Scope | LocalHttpServerStore | TunnelStore
> =>
  Effect.gen(function* () {
    const tunnelStore = yield* TunnelStore
    const serverStore = yield* LocalHttpServerStore

    const instanceRef = yield* SynchronizedRef.make<Instance | null>(null)

    yield* Effect.addFinalizer(() =>
      SynchronizedRef.updateEffect(instanceRef, (current) =>
        current === null
          ? Effect.succeed(null)
          : Scope.close(current.scope, Exit.void).pipe(Effect.as(null))
      )
    )

    const clearCurrent = Effect.sync(() =>
      tunnelStore.commit(TunnelState.events.tunnelStateSet({ currentPublicOrigin: null }))
    )

    const tearDown = (current: Instance): Effect.Effect<null, never, never> =>
      Scope.close(current.scope, Exit.void).pipe(Effect.zipRight(clearCurrent), Effect.as(null))

    const startInstance = (
      requested: string,
      port: number,
      localOrigin: string
    ): Effect.Effect<Instance | null, never, never> =>
      Effect.gen(function* () {
        const newScope = yield* Scope.make()
        const result = yield* TunnelExpo.acquire({
          port,
          subdomain: TUNNEL_SUBDOMAIN,
          fallbackOrigin: localOrigin,
        }).pipe(Scope.extend(newScope), Effect.either)
        if (result._tag === 'Left') {
          yield* Effect.logError(
            `[wildflower-expo] tunnel acquire failed for ${requested}: ${result.left.message}`
          )
          yield* Scope.close(newScope, Exit.void)
          return null
        }
        if (result.right !== requested) {
          yield* Effect.logWarning(
            `[wildflower-expo] tunnel granted ${result.right}, expected ${requested}; tearing down`
          )
          yield* Scope.close(newScope, Exit.void)
          return null
        }
        yield* Effect.sync(() =>
          tunnelStore.commit(
            TunnelState.events.tunnelStateSet({ currentPublicOrigin: result.right })
          )
        )
        return { requestedFor: requested, scope: newScope }
      })

    const decision$: Stream.Stream<Decision> = Stream.zipLatest(
      tunnelStore.subscribeStream(TunnelState.queries.current$),
      serverStore.subscribeStream(ServerState.queries.current$)
    ).pipe(
      Stream.map(
        ([tunnel, server]): Decision => ({
          requested: tunnel.requestedPublicOrigin,
          serverReady: server.running,
          port: server.port,
          localOrigin: server.localOrigin,
        })
      )
    )

    return yield* decision$.pipe(
      Stream.runForEach(({ requested, serverReady, port, localOrigin }) =>
        SynchronizedRef.updateEffect(instanceRef, (current) => {
          // Server down or no request: tear down any current instance.
          if (requested === null || !serverReady || port === null || localOrigin === null) {
            return current === null ? Effect.succeed(null) : tearDown(current)
          }
          // Request changed mid-flight: tear down so we can restart for
          // the new URL on the next tick.
          if (current !== null && current.requestedFor !== requested) {
            return tearDown(current)
          }
          // Already running for this request: nothing to do.
          if (current !== null) return Effect.succeed(current)
          // Fresh start.
          return startInstance(requested, port, localOrigin)
        })
      )
    )
  })

export { tunnelDaemon }
