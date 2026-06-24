import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { type AnyRouter, createRouter, type RouterHistory } from '@tanstack/react-router'
import { Effect, type Fiber, type Subscribable, Stream } from 'effect'
import {
  ActiveDeviceUserCodeProvider,
  makeActiveDeviceUserCodeStore,
  type ActiveDeviceUserCodeStore,
} from 'gatekeeper-react'
import type { NavTarget } from 'navigation-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthTokenProvider, type AuthTokenStore } from 'react-kitchen-sink'
import { ErrorBoundary } from 'react-tundraish'
import type { BaseRouterContext } from 'shared-structures-react'
import { Sentry } from 'telemetry-web'

import { buildAppQueryRuntime } from './bridges/app-query-runtime.ts'
import { AppRootTree } from './bridges/app-root-tree.tsx'
import type { ReactTransport } from './bridges/transport-context.ts'
// Self-hosted Wildflower fonts — loaded here so every entry (web, single-web,
// embedded, and the Tauri shell via `wildflower-react/app-root`) picks them up
// through a single import.
import './styles/fonts.ts'
import { routeTree } from './routeTree.gen.ts'

/**
 * Per-entry transport factory. Receives a stable `navigate` closure
 * that delegates to the router instance (set after `createRouter`),
 * a `writeIssuedToken` writer threaded from the entry's
 * {@link AuthTokenStore}, and a `setActiveDeviceUserCode` writer
 * threaded from the in-app {@link ActiveDeviceUserCodeStore}; returns
 * the page's `BridgeTransport` (narrowed to the React-facing
 * `ReactTransport` surface). Web entries return a pre-resolved stub
 * and ignore both setters (no host bridge to receive `AuthTokenIssued`
 * or `DeviceConsentRequested` from); embedded/Tauri wires both into
 * the gatekeeper page-bridge handler so host pushes land in the
 * corresponding stores.
 */
type MakeTransport = (
  navigate: (to: NavTarget) => void,
  writeIssuedToken: AuthTokenStore['setToken'],
  setActiveDeviceUserCode: ActiveDeviceUserCodeStore['setActiveUserCode']
) => Promise<ReactTransport>

/**
 * Per-entry `awaitAuthReady` factory. Receives a `transportReady`
 * promise (resolved once the transport's boot-time `signalReady` has
 * settled) and returns the actual `awaitAuthReady` function the
 * `beforeLoad` gate calls. Web's implementation ignores the argument
 * (standalone has no host handshake to wait); embedded's awaits it
 * before reading the token subscribable. Lifting the transport wait
 * into the factory means the gate stays environment-agnostic and the
 * router context no longer needs its own `transportReady` field.
 *
 * The entry closes over its own {@link AuthTokenStore.subscribable}
 * here — `gatekeeper-react`'s `makeAwaitWebAuthReady` /
 * `makeAwaitEmbeddedAuthReady` take a subscribable and return the
 * shape `BaseRouterContext.AwaitAuthReady` expects.
 */
type MakeAwaitAuthReady = (transportReady: Promise<void>) => BaseRouterContext.AwaitAuthReady

/**
 * Fork the token-rotation cache invalidator.
 *
 * Subscribes to the bearer token's `subscribable.changes` and calls
 * `queryClient.invalidateQueries()` on every *post-mount* rotation, so
 * any 401-cached entries from a previous bearer refetch with the new
 * one (the cache is keyed on the query, not on the bearer — without
 * this a stale-token failure pins until the user navigates away).
 *
 * `Stream.drop(1)` skips the `SubscriptionRef`'s replayed initial value
 * so the first subscribe does NOT flush the cache — invalidating at
 * boot would be a wasted full cache flush before anything is cached.
 *
 * Extracted from {@link renderApp} (which builds its own `QueryClient`)
 * so the boot-skip / rotate-flush contract is unit-testable against a
 * real `Subscribable` and a spy-able `QueryClient` without mounting the
 * whole app. Returns the forked fiber so callers (or tests) can await /
 * interrupt it.
 */
const forkTokenRotationInvalidator = (
  subscribable: Subscribable.Subscribable<string | null>,
  queryClient: QueryClient
): Fiber.RuntimeFiber<void, never> =>
  Effect.runFork(
    Stream.runForEach(Stream.drop(subscribable.changes, 1), () =>
      Effect.sync(() => {
        void queryClient.invalidateQueries()
      })
    )
  )

interface RenderAppOptions {
  /** Browser history for web, memory history for embedded WebView. */
  readonly history: RouterHistory
  /** Tagged onto Sentry events to distinguish web/embedded crashes. */
  readonly entry: 'main-web' | 'main-embedded' | 'main-single-web' | 'main-tauri'
  /**
   * Environment-specific {@link AuthTokenStore}. Web entries pass
   * `makeWebAuthTokenStore()` (localStorage-backed); embedded passes
   * `makeEmbeddedAuthTokenStore()` (in-memory only, see its docstring
   * for the why). Threaded into `<AuthTokenProvider>` for descendants,
   * into the `BearerToken` Layer for Effect-side HTTP clients, into
   * the page-bridge handler via `makeTransport`, and into a
   * token-rotation invalidator that flushes TanStack Query's cache
   * when the bearer changes (so 401-pinned entries don't outlive the
   * rotation).
   */
  readonly tokenStore: AuthTokenStore
  /**
   * Environment-specific auth-readiness factory, injected per entry.
   * Called once at `renderApp` time with `transportReady`; the
   * resolved function is threaded into router context so the
   * `beforeLoad` gate calls it without knowing the environment — the
   * entry, not a context flag, encodes the behavior.
   */
  readonly awaitAuthReady: MakeAwaitAuthReady
  /**
   * Per-entry transport factory (real for embedded, stub for web).
   * Called once before `createRouter`; its returned promise feeds
   * `context.transport` (for the `_auth` loader's `UIReady` emit) and
   * is consumed inside the React tree via `usePromiseOrDefault` to
   * seed `TransportContext`.
   */
  readonly makeTransport: MakeTransport
  /**
   * Absolute API origin for entries whose page is not served by the
   * API server (the Tauri webview loads from the dev server / asset
   * protocol while the API lives on the host's loopback server).
   * Omitted, HTTP clients resolve their relative paths against the
   * page origin, as on web/embedded.
   */
  readonly apiBaseUrl?: string
}

/**
 * Mount the app under `#root`. Called once per entry point.
 *
 * The same `QueryClient` is given to both `<QueryClientProvider>` and
 * `createRouter`'s `context`, so loaders' `ensureQueryData` and
 * components' `useQuery` share one cache. Cache is in-memory only —
 * no persister; warm via preloading.
 *
 * Token rotation flushes the cache via
 * {@link forkTokenRotationInvalidator}: a forked fiber on
 * `tokenStore.subscribable.changes` (after the replayed initial
 * value) calls `queryClient.invalidateQueries()` so any 401-cached
 * entries from a previous bearer refetch with the new one. Without
 * this, a stale-token failure pins until the user navigates away —
 * the cache is keyed on the query, not on the bearer.
 *
 * The transport is built *outside* React, before the router mounts.
 * Its boot-time `signalReady` settles into `transportReady`, which
 * `awaitAuthReady` (the embedded factory) waits on internally — so
 * the embedded ordering ("transport ready before host pushes token")
 * is encoded inside `awaitAuthReady` itself rather than in a separate
 * `transportReady` field on router context.
 *
 * `navigate` (used by the navigation bridge's web handlers to handle
 * `HostRequestedWebNavigation` / `HostBackRequested`) closes over a
 * `routerHandle` cell set immediately after `createRouter`. Host nav
 * messages can only arrive after `transport.signalReady`, by which
 * point the cell is populated.
 */
const renderApp = ({
  history,
  entry,
  tokenStore,
  awaitAuthReady,
  makeTransport,
  apiBaseUrl,
}: RenderAppOptions): void => {
  const { queryClient, runAuthed, runtimeLayer } = buildAppQueryRuntime(
    tokenStore.subscribable,
    apiBaseUrl
  )

  forkTokenRotationInvalidator(tokenStore.subscribable, queryClient)

  const routerHandle: { current: AnyRouter | null } = { current: null }
  const navigate = (to: NavTarget): void => {
    const router = routerHandle.current
    if (router === null) return
    if (typeof to === 'number') router.history.back()
    else void router.navigate({ to })
  }

  // Built once per renderApp. Only the Tauri host ever pushes
  // `DeviceConsentRequested`, but the store and provider are wired in
  // every entry so the modal host's hook contract is identical
  // everywhere (no per-entry guard inside the gatekeeper-react surface).
  const activeDeviceUserCodeStore = makeActiveDeviceUserCodeStore()

  const transportPromise = makeTransport(
    navigate,
    tokenStore.setToken,
    activeDeviceUserCodeStore.setActiveUserCode
  )
  const transportReady = transportPromise.then(() => undefined)
  const resolvedAwaitAuthReady = awaitAuthReady(transportReady)

  const router = createRouter({
    routeTree,
    history,
    context: {
      queryClient,
      runAuthed,
      runtimeLayer,
      awaitAuthReady: resolvedAwaitAuthReady,
      transport: transportPromise,
      // Threaded so the apps launch POST targets the host API origin (the
      // Tauri entry's loopback) rather than the page origin; undefined on
      // web/embedded, where the page is served by the API.
      apiBaseUrl,
    },
    defaultPreload: 'intent',
  })
  routerHandle.current = router

  const container = document.getElementById('root')
  if (container === null) {
    throw new Error('root element not found')
  }
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary
        onError={(error, info) => {
          console.error(`[${entry}] Uncaught error:`, error, info)
          Sentry.captureException(error, {
            extra: { componentStack: info.componentStack ?? undefined },
          })
        }}
        extraContext={{
          mode: import.meta.env.MODE,
          entry,
        }}
      >
        <QueryClientProvider client={queryClient}>
          <AuthTokenProvider store={tokenStore}>
            <ActiveDeviceUserCodeProvider store={activeDeviceUserCodeStore}>
              <AppRootTree router={router} transportPromise={transportPromise} />
            </ActiveDeviceUserCodeProvider>
          </AuthTokenProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>
  )
}

export { forkTokenRotationInvalidator, renderApp }
export type { MakeAwaitAuthReady, MakeTransport, RenderAppOptions }
