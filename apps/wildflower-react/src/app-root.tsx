import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { type AnyRouter, createRouter, type RouterHistory } from '@tanstack/react-router'
import { Effect, type Fiber, type Subscribable, Stream } from 'effect'
import {
  ActiveDeviceUserCodeProvider,
  buildDeviceLoginTarget,
  DEVICE_LOGIN_ROUTE,
  makeActiveDeviceUserCodeStore,
  type ActiveDeviceUserCodeStore,
} from 'gatekeeper-react'
import type { NavTarget } from 'navigation-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { type AuthSignal, AuthTokenProvider, type AuthTokenStore } from 'react-kitchen-sink'
import { ErrorBoundary } from 'react-tundraish'
import type { BaseRouterContext, SettingsItem } from 'shared-structures-react'
import { Sentry } from 'telemetry-web'

import { buildAppQueryRuntime } from './bridges/app-query-runtime.ts'
import { AppRootTree } from './bridges/app-root-tree.tsx'
import type { ReactTransport } from './bridges/transport-context.ts'
import { routeTree } from './routeTree.gen.ts'
// Self-hosted Wildflower fonts — loaded here so every entry (web, single-web,
// and the Tauri shell via `wildflower-react/app-root`) picks them up through a
// single import.
import './styles/fonts.ts'

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
  writeIssuedToken: AuthTokenStore['setSignal'],
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
  subscribable: Subscribable.Subscribable<AuthSignal>,
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
  readonly entry: 'main-web' | 'main-single-web' | 'main-tauri'
  /**
   * Environment-specific {@link AuthTokenStore}. Web entries pass
   * `makeWebAuthTokenStore()` (cookie-derived auth signal — the real JWT
   * is the `HttpOnly` `wf_auth` cookie, invisible to JS); embedded passes
   * `makeEmbeddedAuthTokenStore()` (in-memory raw JWT, see its docstring
   * for the why). Threaded into `<AuthTokenProvider>` for descendants and
   * into a token-rotation invalidator that flushes TanStack Query's cache
   * when the auth signal changes (so 401-pinned entries don't outlive a
   * sign-in or rotation). HTTP clients are tokenless — auth rides the
   * same-origin `HttpOnly` `wf_auth` cookie, not a JS-attached header.
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
  /**
   * The host's granted-scope string (e.g. `system/*.cruds wildflower/*.cruds`),
   * sourced from the Tauri shell's `tauri-shared-config.json`. Threaded into
   * router context so `NeedsAuthMessage` requests exactly the scopes
   * gatekeeper-rust seeds for the first-party client. Omitted on web/embedded.
   */
  readonly localGrantedScopes?: string
  /**
   * Platform-specific settings rows this entry contributes to the shared
   * `/settings` list. Threaded into `AppRootTree`, which provides them to the
   * tree for the settings route to append (see
   * `session/platform-settings-items-context.ts`). Standalone-web entries pass
   * the web logout item; `main-tauri` passes `[]`. Keeping the choice at the
   * entry — the only place that knows the platform — means the settings route
   * stays a dumb renderer with no `entry`-sniffing branch.
   */
  readonly platformSettingsItems: readonly SettingsItem[]
  /**
   * Per-entry 401 fallback factory. Receives `redirectToDeviceLogin` (which
   * closes over the router built inside `renderApp`) and returns the
   * `onUnauthorized` handler the QueryCache calls when an authed request ends in
   * a 401 that outlived the boot-race retry. Web entries return the redirect
   * (they have a device-login flow); `main-tauri` returns a no-op — the webview
   * is host-authenticated, so there's no user login to fall back to and driving
   * the device flow would spawn a spurious consent against the owner's own
   * device. Injecting it keeps the platform decision at the entry seam instead
   * of behind an `entry`-string branch in this shared code.
   */
  readonly makeOnUnauthorized: (redirectToDeviceLogin: () => void) => () => void
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
  localGrantedScopes,
  platformSettingsItems,
  makeOnUnauthorized,
}: RenderAppOptions): void => {
  // Router isn't built until after the query runtime (its context needs the
  // runtime), so the closures that navigate imperatively read it through this
  // deferred cell, populated right after `createRouter`.
  const routerHandle: { current: AnyRouter | null } = { current: null }

  // Fires when an authed query/mutation ends in a 401 that outlived the
  // boot-race retry — the cookie session is genuinely gone, so send the user to
  // device login, preserving where they were as `returnTo`. The guard skips a
  // redundant navigation when they're already on the device-login route.
  const redirectToDeviceLogin = (): void => {
    const router = routerHandle.current
    if (router === null) return
    if (router.state.location.pathname === DEVICE_LOGIN_ROUTE) return
    void router.navigate(buildDeviceLoginTarget(router.state.location.href))
  }

  // Which 401 fallback this entry uses is the entry's decision, injected as
  // `makeOnUnauthorized` — not an `entry`-string branch here. Web entries return
  // `redirectToDeviceLogin`; `main-tauri` returns a no-op (see the field doc and
  // the entrypoints). A new entry must state its own behavior at its seam.
  const onUnauthorized = makeOnUnauthorized(redirectToDeviceLogin)
  const { queryClient, runAuthed, runtimeLayer } = buildAppQueryRuntime(apiBaseUrl, onUnauthorized)

  // Keyed on the auth *signal* (the store), not the bearer source: on web a
  // sign-in flips the cookie-derived signal and should flush the cache.
  forkTokenRotationInvalidator(tokenStore.subscribable, queryClient)

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
    tokenStore.setSignal,
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
      // Threaded so the apps launch POST reaches the host API origin — see
      // `RouterContext.apiBaseUrl`.
      apiBaseUrl,
      // Threaded so `NeedsAuthMessage` requests exactly gatekeeper's seeded
      // first-party scopes — see `RouterContext.localGrantedScopes`.
      localGrantedScopes,
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
          // oxlint-disable-next-line no-console
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
              <AppRootTree
                router={router}
                transportPromise={transportPromise}
                platformSettingsItems={platformSettingsItems}
              />
            </ActiveDeviceUserCodeProvider>
          </AuthTokenProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>
  )
}

export { forkTokenRotationInvalidator, renderApp }
export type { MakeAwaitAuthReady, MakeTransport, RenderAppOptions }
