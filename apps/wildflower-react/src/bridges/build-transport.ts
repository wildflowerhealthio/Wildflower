import { Effect, Layer, Scope } from 'effect'
import { BridgeTransport, Logging, TransportAdapter } from 'effect-messaging-core'
import { makeHandlerCoordinator, WebPlatformAdapter } from 'effect-messaging-react'
import type { ActiveDeviceUserCodeStore } from 'gatekeeper-react'
import type { NavTarget } from 'navigation-react'
import type { AuthTokenStore } from 'react-kitchen-sink'
import { webTelemetryLayerFromEnv } from 'telemetry-web'

import { makeBootStableInitialHandlers } from './boot-stable-handlers.ts'
import { bridges } from './bridges.ts'
import type { ReactTransport } from './transport-context.ts'

/**
 * Builds the page-side `BridgeTransport` once at boot. Resolves to the
 * React-facing {@link ReactTransport} once `signalReady` has fired. The
 * transport lives for the page's lifetime — no teardown.
 *
 * Boot ordering and the page-lifetime philosophy are documented in
 * [Web Handler Coordinator Explanation](../../../../docs/Effect/Web%20Handler%20Coordinator%20Explanation.md).
 */
const SIGNAL_READY_DEBUG_TIMEOUT_MS = 10_000

const buildTransport = (
  navigate: (to: NavTarget) => void,
  setSignal: AuthTokenStore['setSignal'],
  setActiveDeviceUserCode: ActiveDeviceUserCodeStore['setActiveUserCode']
): Promise<ReactTransport> => {
  const adapter = WebPlatformAdapter.make(bridges)
  // Never closed — see the page-lifetime note in the explanation doc.
  const pageLifetimeScope = Effect.runSync(Scope.make())

  const { initialHandlers, connect } = makeHandlerCoordinator({
    bridges,
    initial: makeBootStableInitialHandlers(navigate, setSignal, setActiveDeviceUserCode),
  })

  return Effect.runPromise(
    Scope.extend(
      BridgeTransport.makeWebTransport({ bridges, handlers: initialHandlers }).pipe(
        Effect.provide(Layer.succeed(TransportAdapter, adapter)),
        // Set the OTel tracer FiberRef on the building fiber. The
        // transport's `forkScoped` inbound-dispatch fiber and the bridge
        // handlers' `forkDaemon` timers snapshot it at fork time, so the
        // `Effect.withSpan` calls in the collector handlers emit spans to
        // Sentry. No-op (`Layer.empty`) when telemetry is disabled.
        Effect.provide(webTelemetryLayerFromEnv())
      ),
      pageLifetimeScope
    )
  ).then(async (transport) => {
    // Install the interceptor *before* awaiting signalReady so any
    // `console.*` emitted by Sentry init, the transport's own internals,
    // or the adapter's `drainInitial` rides the outbox-then-flush path.
    Logging.installConsoleInterceptor((msg: Logging.LogPayload) => {
      Effect.runFork(transport.sendMessage(msg))
    })
    // Debug-mode hang detector: log once if `signalReady` doesn't
    // resolve within the timeout. The web's `signalReady` is a
    // fire-and-forget post in current adapters, so this should never
    // fire — when it does, surface it for diagnosis.
    const debugTimer = setTimeout(() => {
      // oxlint-disable-next-line no-console
      console.warn(
        `[bridges] transport.signalReady has not resolved after ${SIGNAL_READY_DEBUG_TIMEOUT_MS}ms — bare-sender may be wedged or peer never received __Ready`
      )
    }, SIGNAL_READY_DEBUG_TIMEOUT_MS)
    try {
      await Effect.runPromise(transport.signalReady)
    } finally {
      clearTimeout(debugTimer)
    }
    return {
      sendMessage: transport.sendMessage,
      coordinator: connect(transport.registerHandlers),
    }
  })
}

export { buildTransport, SIGNAL_READY_DEBUG_TIMEOUT_MS }
