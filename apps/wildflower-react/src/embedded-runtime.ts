import { NavigationBridge, EffectRuntimeGlobal } from 'contracts-core'
import { type NavRef } from 'contracts-react'
import { Effect, Layer, ManagedRuntime, Schema, Scope } from 'effect'
import { BridgeTransport, PlatformAdapter, Message } from 'effect-messaging-core'
import { WebPlatformAdapter } from 'effect-messaging-react'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { bootstrapTokenFromUrl, gatekeeperWebReceiverLayer } from 'gatekeeper-react/web-bridge'

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
 * - {@link initialEntry} — the initial path for `<MemoryRouter>` so
 *   the router mounts at the route the host requested.
 * - {@link navRef}, {@link pendingNavigations} — wired through
 *   `<NavigateBinder>` (from `contracts-react`) inside the router
 *   tree so the navigation bridge's handler can dispatch pre-mount
 *   events into the queue, post-mount events through the ref.
 */

// Mutable navigate-binding for `HostBackRequested` and the live
// `HostRequestedWebNavigation` handlers. Module-load handlers fire
// before React's `useNavigate` is available; the layer's handler
// pushes to the queue when `navRef.current === null`, and routes
// through the ref once `<NavigateBinder>` has mounted.
const navRef: NavRef = { current: null }
const pendingNavigations: Array<-1 | string> = []

const enqueueNavigate = (target: -1 | string): void => {
  const navigate = navRef.current
  if (navigate !== null) {
    navigate(target)
    return
  }
  pendingNavigations.push(target)
}

const navigationLayer = NavigationBridge.Web.ReceiverLayer({
  HostBackRequested: () => Effect.sync(() => enqueueNavigate(-1)),
  HostRequestedWebNavigation: ({ path }) => Effect.sync(() => enqueueNavigate(path)),
})

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

/**
 * Find the path the host requested in the pre-injected initial
 * messages. Returns `'/'` when no `HostRequestedWebNavigation` entry
 * is present (e.g. the bundle is running standalone-web).
 */
const findInitialPath = (messages: ReadonlyArray<string>): string => {
  for (const entry of messages) {
    try {
      const envelope = Schema.decodeUnknownSync(Message.taggedMessageSchema)(entry)
      if (envelope._tag === 'HostRequestedWebNavigation') {
        return Schema.decodeSync(NavigationBridge.MessageSchemas.HostRequestedWebNavigation)(entry)
          .path
      }
    } catch {
      continue
    }
  }
  return '/'
}

/**
 * Initial path extracted from the drained initial messages. Used by
 * `<MemoryRouter initialEntries={[initialEntry]}>` so the router
 * mounts at the right path on first paint, before the dispatch
 * fiber's replay arrives.
 */
const initialEntry = findInitialPath(initialMessages)

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
      layers: [navigationLayer, gatekeeperWebReceiverLayer] as const,
      side: 'Web',
    }).pipe(Effect.provide(Layer.succeed(PlatformAdapter, replayAdapter))),
    scope
  )
)

// URL fallback for the standalone-web bundle (no host bridge present)
// — populates the bearer from `?token=` if the SPA was opened
// directly. No-op when the embedded host already provided
// `AuthTokenIssued`.
bootstrapTokenFromUrl()

export { initialEntry, navRef, pendingNavigations, transport }
