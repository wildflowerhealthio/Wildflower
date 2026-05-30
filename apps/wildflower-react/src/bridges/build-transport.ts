import { AppsBridge } from 'apps-core/bridge'
import { appsWebReceiverLayer } from 'apps-react'
import { CollectorBridge } from 'collector-fundamentals/bridge'
import { collectorWebReceiverLayer } from 'collector-react'
import { Effect, Layer, Scope } from 'effect'
import { BridgeTransport, Logging, TransportAdapter } from 'effect-messaging-core'
import { WebPlatformAdapter } from 'effect-messaging-react'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { gatekeeperWebReceiverLayer } from 'gatekeeper-react/web-bridge'
import { NavigationBridge } from 'navigation-core'
import { makeNavigationWebReceiverLayer, type NavTarget } from 'navigation-react'

import type { Transport } from './transport-context.ts'

/**
 * Build the page-side `BridgeTransport` once at boot, outside React.
 * Returns a Promise that resolves to the live transport after its
 * inbound queue has drained (`flushed`) and the Host has been told to
 * start sending (`signalReady`).
 *
 * The slice receiver layers (`apps`, `collector`, `gatekeeper`) are
 * module-level constants that close over module-level mutable cells
 * (`pendingTunnelResolverRef`, `activeHandlerRef`, `authTokenRef`).
 * That's what makes building the transport outside React possible: no
 * hook needs to run first to produce a closure-bound layer.
 *
 * `navigate` is passed in by the caller. It's the only seam onto the
 * router, captured behind a stable indirection so the transport build
 * can run before `createRouter` returns (the caller wires up a
 * router-instance ref and supplies a closure that reads it).
 *
 * Page lifetime — there is no teardown. `Scope.make` is created and
 * never closed; the transport, its dispatch fiber, and the console
 * interceptor live as long as the page does. (Tests that need teardown
 * can call `BridgeTransport.make` directly with their own scope.)
 */
const buildTransport = (navigate: (to: NavTarget) => void): Promise<Transport> => {
  const navLayer = makeNavigationWebReceiverLayer(navigate)
  const bridges = [
    NavigationBridge,
    GatekeeperBridge,
    CollectorBridge,
    AppsBridge,
    Logging.LogBridge,
  ] as const
  const adapter = WebPlatformAdapter.make(bridges)
  const scope = Effect.runSync(Scope.make())
  return Effect.runPromise(
    Scope.extend(
      BridgeTransport.make({
        bridges,
        layers: [
          navLayer,
          gatekeeperWebReceiverLayer,
          collectorWebReceiverLayer,
          appsWebReceiverLayer,
          // Logging is Web→Host only on the page side; the Web
          // ReceiverLayer is the empty `{}` handlers record.
          Logging.LogBridge.Web.ReceiverLayer({}),
        ] as const,
        side: 'Web',
      }).pipe(Effect.provide(Layer.succeed(TransportAdapter, adapter))),
      scope
    )
  ).then(async (transport) => {
    await Effect.runPromise(Effect.andThen(transport.flushed, transport.signalReady))
    Logging.installConsoleInterceptor((msg: Logging.LogPayload) => {
      Effect.runFork(transport.sendMessage(msg))
    })
    return transport
  })
}

export { buildTransport }
