import { appsWebReceiverLayer } from 'apps-react'
import { collectorWebReceiverLayer } from 'collector-react'
import { Effect, Layer, Scope } from 'effect'
import { BridgeTransport, Logging, TransportAdapter } from 'effect-messaging-core'
import { WebPlatformAdapter } from 'effect-messaging-react'
import { gatekeeperWebReceiverLayer } from 'gatekeeper-react/web-bridge'
import { makeNavigationWebReceiverLayer, type NavTarget } from 'navigation-react'

import { bridges } from './bridges.ts'
import type { ReactTransport } from './transport-context.ts'

/**
 * Build the page-side `BridgeTransport` once at boot, outside React.
 * Returns a Promise that resolves to the live transport (narrowed to
 * the React-facing {@link ReactTransport} surface) after its inbound
 * queue has drained (`flushed`) and the Host has been told to start
 * sending (`signalReady`).
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
 *
 * @remarks
 * The console interceptor is installed BEFORE the `flushed →
 * signalReady` chain runs so that any `console.*` emitted by Sentry
 * init (`instrument.ts`), `BridgeTransport.make` internals, or the
 * adapter's `drainInitial` get routed through the transport's outbound
 * dispatch — buffered behind the bridge's `peerReady` gate until the
 * host comes online, then drained in order. Installing post-`flushed`
 * (the previous shape) silently dropped those early lines.
 */
const buildTransport = (navigate: (to: NavTarget) => void): Promise<ReactTransport> => {
  const navLayer = makeNavigationWebReceiverLayer(navigate)
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
    Logging.installConsoleInterceptor((msg: Logging.LogPayload) => {
      Effect.runFork(transport.sendMessage(msg))
    })
    await Effect.runPromise(Effect.andThen(transport.flushed, transport.signalReady))
    return transport
  })
}

export { buildTransport }
