import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect'
import { BridgeTransport, PlatformAdapter } from 'effect-messaging-core'
import { WebPlatformAdapter } from 'effect-messaging-react'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { gatekeeperWebReceiverLayer } from 'gatekeeper-react/web-bridge'
import { NavigationBridge } from 'navigation-core'
import { navigationWebReceiverLayer } from 'navigation-react'

// Top-level await on `managedRuntime.runPromise` below blocks first paint on
// the runtime build. Cheap with `Layer.empty`; if telemetry/logger overrides
// plug in here later, move into a lazy-init seam.
const managedRuntime = ManagedRuntime.make(Layer.empty)

const webAdapter = WebPlatformAdapter.make()
const initialMessages: ReadonlyArray<string> = Effect.runSync(webAdapter.drainInitial)

// Replay adapter — see `effect-messaging-react/README.md` for the drain-then-replay rationale.
const replayAdapter: PlatformAdapter['Type'] = {
  bareSender: webAdapter.bareSender,
  drainInitial: Effect.succeed(initialMessages),
  attachLive: webAdapter.attachLive,
}

const scope = Effect.runSync(Scope.make())
const transport = await managedRuntime.runPromise(
  Scope.extend(
    BridgeTransport.make({
      bridges: [NavigationBridge, GatekeeperBridge] as const,
      layers: [navigationWebReceiverLayer, gatekeeperWebReceiverLayer] as const,
      side: 'Web',
    }).pipe(Effect.provide(Layer.succeed(PlatformAdapter, replayAdapter))),
    scope
  )
)

// Vite re-imports the module on hot reload; without this, every reload
// accumulates a scope, dispatch fiber, ManagedRuntime, and window listener.
if (import.meta.hot !== undefined) {
  import.meta.hot.dispose(() => {
    Effect.runFork(Scope.close(scope, Exit.void))
    Effect.runFork(managedRuntime.disposeEffect)
  })
}

export { initialMessages, transport }
