import { NavigationBridge, EffectRuntimeGlobal } from 'contracts-core'
import { navigationWebReceiverLayer } from 'contracts-react'
import { Effect, Layer, ManagedRuntime, Scope } from 'effect'
import { BridgeTransport, PlatformAdapter } from 'effect-messaging-core'
import { WebPlatformAdapter } from 'effect-messaging-react'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { gatekeeperWebReceiverLayer } from 'gatekeeper-react/web-bridge'

/**
 * Module-level setup for the embedded SPA bundle. Constructs the
 * `ManagedRuntime`, installs it into the Effect runtime slot, drains
 * the host-injected initial messages once (so the dispatch fiber gets
 * to see them and the bundle can synchronously seed `<MemoryRouter>`
 * at the right path), builds the multi-bridge web transport against a
 * replay adapter, and runs the standalone-web URL token fallback.
 *
 * Side-effects fire on import — that mirrors the entrypoint contract;
 * the bundle owns the page lifetime, so explicit init isn't worth the
 * ceremony.
 *
 * Exports:
 * - {@link transport} — the live multi-bridge transport. The route
 *   watcher and any future React-side senders go through it.
 * - {@link initialPath} — the initial path for `<MemoryRouter>` so
 *   the router mounts at the route the host requested.

 */

// Build the runtime once at startup. The `ManagedRuntime` carries any
// FiberRefs (logger, services) consumers may add; for now it inherits
// the default logger only. The runtime is exposed via
// `EffectRuntimeGlobal.setEffectRuntime` so React components and the transport's dispatch
// fiber both run against the same runtime.
//
// `Layer.empty` is the placeholder — future telemetry/logger overrides
// plug in here as merged layers without changing the wiring shape.
const managedRuntime = ManagedRuntime.make(Layer.empty)
const runtime = await managedRuntime.runtime()
EffectRuntimeGlobal.setEffectRuntime(runtime)

// Build the live web adapter, then drain `__INITIAL_MESSAGES__` once.
// The adapter's `drainInitial` removes the window global so a hot
// reload doesn't double-replay; we hold onto the strings here so we
// can both peek the initial route and replay them through the
// transport's dispatch fiber (so the auth handler picks up
// `AuthTokenIssued`, etc.).
//
// `drainInitial` is a pure sync Effect (a `window` read + delete), so
// `Effect.runSync` is appropriate — no logger / services needed.
const webAdapter = WebPlatformAdapter.make()
const initialMessages: ReadonlyArray<string> = Effect.runSync(webAdapter.drainInitial)

// Replay adapter: shares the live `bareSender` and `attachLive`, but
// hands the already-drained strings back through `drainInitial` so the
// transport's dispatch fiber sees the same messages once. The window
// global is already gone — `webAdapter.drainInitial` cleared it above.
const replayAdapter: PlatformAdapter['Type'] = {
  bareSender: webAdapter.bareSender,
  drainInitial: Effect.succeed(initialMessages),
  attachLive: webAdapter.attachLive,
}

// Construct the web transport against the replay adapter. The scope
// owns the dispatch fiber and the window listener; both live for the
// page's lifetime. If/when this module becomes HMR-aware, route the
// close through `Scope.close` here.
const scope = Effect.runSync(Scope.make())
/**
 * The live multi-bridge web transport. React-side senders run
 * messages through `transport.sendMessage(...)`; the construction-time
 * runtime threads logger context into the dispatch fiber.
 */
const transport: BridgeTransport.BridgeTransport<
  readonly [NavigationBridge, typeof GatekeeperBridge],
  'Web'
> = await managedRuntime.runPromise(
  Scope.extend(
    BridgeTransport.make({
      bridges: [NavigationBridge, GatekeeperBridge] as const,
      layers: [navigationWebReceiverLayer, gatekeeperWebReceiverLayer] as const,
      side: 'Web',
    }).pipe(Effect.provide(Layer.succeed(PlatformAdapter, replayAdapter))),
    scope
  )
)

export { initialMessages, transport }
