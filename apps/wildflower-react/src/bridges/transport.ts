import { NavigationBridge, EffectRuntimeGlobal } from 'contracts-core'
import { navigationWebReceiverLayer } from 'contracts-react'
import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect'
import { BridgeTransport, PlatformAdapter } from 'effect-messaging-core'
import { WebPlatformAdapter } from 'effect-messaging-react'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { gatekeeperWebReceiverLayer } from 'gatekeeper-react/web-bridge'

/**
 * Module-load wiring for the SPA bundle: builds the runtime, drains the
 * host-injected initial messages once, and stands up the multi-bridge
 * web transport against a replay adapter so the dispatch fiber sees
 * those messages exactly once.
 *
 * Top-level await note: `await managedRuntime.runtime()` blocks first
 * paint on the runtime build. With `Layer.empty` that's effectively
 * free; if telemetry/logger overrides plug in here later, the cost
 * grows and this should be moved into a lazy-init seam (Layer.unwrap or
 * a React provider) so paint doesn't wait on it.
 */

const managedRuntime = ManagedRuntime.make(Layer.empty)
const runtime = await managedRuntime.runtime()
EffectRuntimeGlobal.setEffectRuntime(runtime)

const webAdapter = WebPlatformAdapter.make()
const initialMessages: ReadonlyArray<string> = Effect.runSync(webAdapter.drainInitial)

// Replay adapter: shares `bareSender` / `attachLive`, hands the drained
// strings back through `drainInitial` so the dispatch fiber sees them.
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
