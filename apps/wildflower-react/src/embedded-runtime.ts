import { Effect, Layer, ManagedRuntime, Scope, Schema } from 'effect'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { bootstrapTokenFromUrl, gatekeeperWebReceiverLayer } from 'gatekeeper-react/web-bridge'
import {
  envelopeSchema,
  NativeRequestedWebNavigation,
  NavigationBridge,
  setInteropRuntime,
} from 'interop-core'
import { makeWebTransport, type WebTransport } from 'interop-react'

/**
 * Module-level setup for the embedded SPA bundle. Constructs the
 * `ManagedRuntime`, installs it into the interop runtime slot, peeks
 * the pre-mount initial path, builds the multi-bridge web transport,
 * and runs the standalone-web URL token fallback. Side-effects fire
 * on import — that mirrors the entrypoint contract; the bundle owns
 * the page lifetime, so explicit init isn't worth the ceremony.
 *
 * Exports:
 * - {@link transport} — the live multi-bridge transport. The route
 *   watcher and any future React-side senders go through it.
 * - {@link initialEntry} — the initial path for `<MemoryRouter>` so
 *   the router mounts at the route the host requested.
 * - {@link bindNavigate} — populates the navigate ref and flushes any
 *   pre-mount queued navigation events; called from the React tree's
 *   `<NavigateBinder>` once `useNavigate` is available.
 */

type WindowGlobals = Window & { __INITIAL_MESSAGES__?: ReadonlyArray<string> }

/**
 * Pre-mount peek of `window.__INITIAL_MESSAGES__` for the initial
 * route. Decodes each entry against the envelope schema, scans for a
 * `NativeRequestedWebNavigation`, and returns its path. Doesn't delete
 * the global — the transport's web adapter does that during its own
 * `drainInitial`, replaying the same messages through the dispatch
 * fiber so the navigation handler also runs (and the auth handler
 * picks up `AuthTokenIssued` if present).
 */
const peekInitialPath = (): string => {
  const win = window as WindowGlobals
  const initial = win.__INITIAL_MESSAGES__
  if (!Array.isArray(initial)) return '/'
  for (const entry of initial) {
    if (typeof entry !== 'string') continue
    try {
      const envelope = Schema.decodeUnknownSync(envelopeSchema)(entry)
      if (envelope._tag === 'NativeRequestedWebNavigation') {
        const decoded = Schema.decodeSync(NativeRequestedWebNavigation)(entry)
        return decoded.path
      }
    } catch {
      continue
    }
  }
  return '/'
}

// Mutable navigate-binding for `NativeBackRequested` and the live
// `NativeRequestedWebNavigation` handlers. Module-load handlers fire
// before React's `useNavigate` is available; queue events until
// `bindNavigate(...)` populates the ref, then flush.
//
// react-router's `NavigateFunction` is overloaded: one signature takes
// a number (delta), the other takes a `To`. The single ref accepts the
// union; both the back handler (calling with `-1`) and the
// runtime-nav handler (calling with a path) land on a valid overload.
type NavigateBack = (delta: number) => void | Promise<void>
type NavigateTo = (path: string) => void | Promise<void>
type NavigateFn = NavigateBack & NavigateTo
const navigateRef: { current: NavigateFn | null } = { current: null }
const pendingNavigations: Array<-1 | string> = []

const enqueueNavigate = (target: -1 | string): void => {
  const navigate = navigateRef.current
  if (navigate !== null) {
    if (typeof target === 'number') void navigate(target)
    else void navigate(target)
    return
  }
  pendingNavigations.push(target)
}

const navigationLayer = NavigationBridge.Web.ReceiverLayer({
  NativeBackRequested: () => Effect.sync(() => enqueueNavigate(-1)),
  NativeRequestedWebNavigation: ({ path }) => Effect.sync(() => enqueueNavigate(path)),
})

// Build the runtime once at startup. The `ManagedRuntime` carries any
// FiberRefs (logger, services) consumers may add; for now it inherits
// the default logger only. The runtime is exposed via
// `setInteropRuntime` so React components and the transport's dispatch
// fiber both run against the same runtime.
//
// `Layer.empty` is the placeholder — future telemetry/logger overrides
// plug in here as merged layers without changing the wiring shape.
const managedRuntime = ManagedRuntime.make(Layer.empty)
const runtime = await managedRuntime.runtime()
setInteropRuntime(runtime)

/**
 * Initial path extracted from `__INITIAL_MESSAGES__`. The transport's
 * `drainInitial` replays the same messages through the dispatch fiber,
 * but by then `<MemoryRouter initialEntries={[initialEntry]}>` has
 * already mounted at the right path.
 */
const initialEntry = peekInitialPath()

// Construct the web transport. `Effect.scoped` makes the dispatch
// fiber + window listener follow this scope — they live for the
// lifetime of the page. No explicit close is needed; if/when this
// module gets HMR-aware, route the close through `Scope.close` here.
const scope = Effect.runSync(Scope.make())
/**
 * The live multi-bridge web transport. React-side senders run
 * messages through `transport.sendMessage(...)`; the construction-time
 * runtime threads logger context into the dispatch fiber.
 */
const transport: WebTransport<readonly [typeof NavigationBridge, typeof GatekeeperBridge]> =
  await managedRuntime.runPromise(
    Scope.extend(
      makeWebTransport({
        bridges: [NavigationBridge, GatekeeperBridge] as const,
        layers: [navigationLayer, gatekeeperWebReceiverLayer] as const,
      }),
      scope
    )
  )

// URL fallback for the standalone-web bundle (no host bridge present)
// — populates the bearer from `?token=` if the SPA was opened
// directly. No-op when the embedded host already provided
// `AuthTokenIssued`.
bootstrapTokenFromUrl()

/**
 * Populate the module-private navigate ref and flush any navigation
 * events queued before React mounted. Called from `<NavigateBinder>`
 * inside the router tree, once `useNavigate` is available.
 */
const bindNavigate = (navigate: NavigateFn): void => {
  navigateRef.current = navigate
  while (pendingNavigations.length > 0) {
    const next = pendingNavigations.shift()
    if (next === undefined) continue
    if (typeof next === 'number') void navigate(next)
    else void navigate(next)
  }
}

export { bindNavigate, initialEntry, transport }
