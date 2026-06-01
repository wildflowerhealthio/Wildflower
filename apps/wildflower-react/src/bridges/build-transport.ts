import { makeAppsWebHandlers } from 'apps-react'
import { makeCollectorWebHandlers } from 'collector-react'
import { Effect, Layer, Scope } from 'effect'
import { BridgeTransport, Logging, TransportAdapter } from 'effect-messaging-core'
import { WebPlatformAdapter } from 'effect-messaging-react'
import { makeGatekeeperWebHandlers } from 'gatekeeper-react/web-bridge'
import { makeNavigationWebHandlers, type NavTarget } from 'navigation-react'

import { bridges } from './bridges.ts'
import type { ReactTransport } from './transport-context.ts'

/**
 * Build the page-side `BridgeTransport` once at boot, outside React.
 * Returns a Promise that resolves to the live transport (narrowed to
 * the React-facing {@link ReactTransport} surface) once the Host has
 * been told the page is ready to receive (`signalReady`).
 *
 * The slice handler records (`apps`, `collector`, `gatekeeper`) are
 * module-level constants that close over module-level mutable cells
 * (`pendingTunnelResolverRef`, `activeHandlerRef`, `authTokenRef`).
 * That's what makes building the transport outside React possible: no
 * hook needs to run first to produce a closure-bound handler record.
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
 * The console interceptor is installed immediately after the transport
 * is built (before `signalReady`) so that any `console.*` emitted by
 * Sentry init (`instrument.ts`), `BridgeTransport.make` internals, or
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
  return Effect.runPromise(
    Scope.extend(
      BridgeTransport.make({
        bridges,
        handlers: [
          navHandlers,
          makeGatekeeperWebHandlers(),
          makeCollectorWebHandlers(),
          makeAppsWebHandlers(),
          // Logging is Web→Host only on the page side; the Web half has
          // no inbound handlers, so its record is empty.
          {},
        ] as const,
        side: 'Web',
      }).pipe(Effect.provide(Layer.succeed(TransportAdapter, adapter))),
      pageLifetimeScope
    )
  ).then(async (transport) => {
    Logging.installConsoleInterceptor((msg: Logging.LogPayload) => {
      Effect.runFork(transport.sendMessage(msg))
    })
    await Effect.runPromise(transport.signalReady)
    return transport
  })
}

export { buildTransport }
