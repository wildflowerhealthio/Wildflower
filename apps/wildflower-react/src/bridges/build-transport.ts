import { Effect, Layer, Scope } from 'effect'
import { BridgeTransport, Logging, TransportAdapter } from 'effect-messaging-core'
import { makeHandlerCoordinator, WebPlatformAdapter } from 'effect-messaging-react'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { makeGatekeeperWebHandlers } from 'gatekeeper-react/web-bridge'
import { NavigationBridge } from 'navigation-core'
import { makeNavigationWebHandlers, type NavTarget } from 'navigation-react'

import { bridges } from './bridges.ts'
import type { ReactTransport } from './transport-context.ts'

/**
 * Build the page-side `BridgeTransport` once at boot, outside React.
 * Returns a Promise that resolves to the React-facing
 * {@link ReactTransport} (sender + handler coordinator) once the Host has
 * been told the page is ready to receive (`signalReady`).
 *
 * Only the boot-stable handler records are composed here: navigation
 * (closes over `navigate`) and gatekeeper (writes the auth-token
 * `SubscriptionRef`). Collector and Apps register their real inbound
 * handlers on mount through the {@link makeHandlerCoordinator} — until
 * then the coordinator serves a drop-all record for those bridges.
 * Logging is web→host only on the page side (no inbound handlers).
 *
 * `navigate` is the only seam onto the router, captured behind a stable
 * indirection so the transport build can run before `createRouter`
 * returns (the caller wires up a router-instance ref and supplies a
 * closure that reads it).
 *
 * Page lifetime — there is no teardown. `Scope.make` is created and
 * never closed; the transport, its dispatch fiber, and the console
 * interceptor live as long as the page does. (Tests that need teardown
 * can call `BridgeTransport.makeWebTransport` directly with their own scope.)
 *
 * @remarks
 * The console interceptor is installed immediately after the transport
 * is built (before `signalReady`) so that any `console.*` emitted by
 * Sentry init (`instrument.ts`), `BridgeTransport.makeWebTransport` internals, or
 * the adapter's `drainInitial` get routed through the transport's
 * outbox — held behind the bridge's `peerReady` gate, then drained in
 * order once it resolves. Installing later would silently drop those
 * early lines.
 */
const buildTransport = (navigate: (to: NavTarget) => void): Promise<ReactTransport> => {
  const navHandlers = makeNavigationWebHandlers(navigate)
  const adapter = WebPlatformAdapter.make(bridges)
  // Never closed — the transport lives for the page's lifetime (see the
  // "Page lifetime" note above). The name makes that deliberate, not a leak.
  const pageLifetimeScope = Effect.runSync(Scope.make())

  const { initialHandlers, connect } = makeHandlerCoordinator({
    bridges,
    inboundDirection: 'HostToWeb',
    initial: {
      [NavigationBridge.name]: navHandlers,
      [GatekeeperBridge.name]: makeGatekeeperWebHandlers(),
    },
  })

  return Effect.runPromise(
    Scope.extend(
      BridgeTransport.makeWebTransport({ bridges, handlers: initialHandlers }).pipe(
        Effect.provide(Layer.succeed(TransportAdapter, adapter))
      ),
      pageLifetimeScope
    )
  ).then(async (transport) => {
    Logging.installConsoleInterceptor((msg: Logging.LogPayload) => {
      Effect.runFork(transport.sendMessage(msg))
    })
    await Effect.runPromise(transport.signalReady)
    return {
      sendMessage: transport.sendMessage,
      coordinator: connect(transport.registerHandlers),
    }
  })
}

export { buildTransport }
