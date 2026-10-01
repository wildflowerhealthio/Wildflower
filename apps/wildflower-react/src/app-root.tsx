import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { type AnyRouter, createRouter, type RouterHistory } from '@tanstack/react-router'
import { Effect, type Fiber, type Layer, type Subscribable, Stream } from 'effect'
import {
  ActivePendingConsentProvider,
  buildDeviceLoginTarget,
  DEVICE_LOGIN_ROUTE,
  makeActivePendingConsentStore,
  type ActivePendingConsentStore,
  TokenResponseHandlerContext,
  type TokenResponseHandler,
} from 'gatekeeper-react'
import { StrictMode, type JSX, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { type AuthState, AuthStateProvider, type AuthStateStore } from 'react-kitchen-sink'
import { ErrorBoundary } from 'react-tundraish'
import type { BaseRouterContext, SettingsItem } from 'shared-structures-react'
import { Sentry } from 'telemetry-web'

import { buildAppQueryRuntime } from './bridges/app-query-runtime.ts'
import { AppRootTree, type AppRootTreeProps } from './bridges/app-root-tree.tsx'
import type { ReactTransport } from './bridges/transport-context.ts'
import { routeTree } from './routeTree.gen.ts'
import type { ServerKind } from './session/server-kind.ts'
// The design-system stylesheet stack, fonts included — imported here so every
// entry (web and the Tauri shell via `wildflower-react/app-root`) picks it up.
// An entry that already imported part of it gets no second copy: the bundler
// dedupes each stylesheet by module id.
import 'react-tundraish/styles'

/**
 * Per-entry transport factory. Receives a `writeIssuedToken` writer
 * threaded from the entry's {@link AuthStateStore} and a
 * `setActivePendingConsent` writer threaded from the in-app
 * {@link ActivePendingConsentStore}; returns the page's transport
 * (narrowed to the React-facing `ReactTransport` surface). Web entries
 * return a pre-resolved stub and ignore both setters (no host bridge to
 * receive `AuthTokenIssued` or `PendingConsentRequested` from); Tauri
 * wires both into the gatekeeper page-bridge handler so host pushes land
 * in the corresponding stores.
 */
type MakeTransport = (
  writeIssuedToken: AuthStateStore['setAuthState'],
  setActivePendingConsent: ActivePendingConsentStore['setActiveHead']
) => Promise<ReactTransport>

/**
 * Per-entry `awaitAuthReady` factory. Receives a `transportReady`
 * promise (resolved once the transport's boot-time handshake has
 * settled) and returns the actual `awaitAuthReady` function the
 * `beforeLoad` gate calls. Web's implementation ignores the argument
 * (standalone has no host handshake to wait); embedded's awaits it
 * before reading the token subscribable. Lifting the transport wait
 * into the factory means the gate stays environment-agnostic and the
 * router context no longer needs its own `transportReady` field.
 *
 * The entry closes over its own {@link AuthStateStore.subscribable}
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
 * Extracted from {@link buildAppTree} (which builds its own `QueryClient`)
 * so the boot-skip / rotate-flush contract is unit-testable against a
 * real `Subscribable` and a spy-able `QueryClient` without mounting the
 * whole app. Returns the forked fiber so callers (or tests) can await /
 * interrupt it.
 */
const forkTokenRotationInvalidator = (
  subscribable: Subscribable.Subscribable<AuthState>,
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
  readonly entry: 'main-web' | 'main-tauri'
  /**
   * Environment-specific {@link AuthStateStore}. `main-web` passes
   * `makeBearerAuthStateStore()` (an in-memory bearer it attaches itself, see
   * `readBearer`); `main-tauri` passes `makeEmbeddedAuthStateStore()` (an
   * in-memory signal the host flips; the page holds no credential). Threaded
   * into `<AuthStateProvider>` for descendants and
   * into a token-rotation invalidator that flushes TanStack Query's cache
   * when the auth signal changes (so 401-pinned entries don't outlive a
   * sign-in or rotation).
   */
  readonly tokenStore: AuthStateStore
  /**
   * Environment-specific auth-readiness factory, injected per entry.
   * Called once at `buildAppTree` time with `transportReady`; the
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
   * The Effect telemetry layer every authed request runs under, binding its
   * spans to the page's tracer provider. The entry decides whether that needs
   * the visitor's consent: `main-web` passes `telemetry-web`'s
   * `consentedTelemetryLayer` (empty until an answer turns performance on);
   * `main-tauri` passes `webTelemetryLayerFromEnv()`, which starts telemetry
   * from the build's env.
   */
  readonly effectTelemetryLayer: Layer.Layer<never>
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
   * The host's first-party OAuth `client_id` (e.g. `wildflower-host`), sourced
   * from the Tauri shell's `tauri-shared-config.json`. Threaded into router
   * context so `NeedsAuthMessage`'s device-login `client_id` matches the id
   * gatekeeper-rust seeds the first-party client under. Omitted on web/embedded
   * (the gatekeeper-core `FIRST_PARTY_CLIENT_ID` fallback applies).
   */
  readonly firstPartyClientId?: string
  /**
   * Where a link meant for another device points, before the router basepath.
   * Threaded into router context for `NeedsAuthMessage`'s device-flow pairing
   * link — see `RouterContext.externalLinkRoot`.
   */
  readonly externalLinkRoot: () => string
  /**
   * Platform-specific settings rows this entry contributes to the shared
   * `/settings` list. Threaded into `AppRootTree`, which provides them to the
   * tree for the settings route to append (see
   * `session/platform-settings-items-context.ts`). `main-web` passes its
   * bearer logout item; `main-tauri` passes `[]`. Keeping the choice at the
   * entry — the only place that knows the platform — means the settings route
   * stays a dumb renderer with no `entry`-sniffing branch.
   */
  readonly platformSettingsItems: readonly SettingsItem[]
  /**
   * Platform-specific tabs this entry contributes to the primary bar, after the
   * shared `TABS` (see `session/platform-tabs-context.ts`). Chosen at the entry
   * for the same reason as `platformSettingsItems`: only the entry knows the
   * platform, so the bar needs no `entry`-sniffing branch. `main-tauri`
   * contributes the HAR Recorder; web entries pass `[]`.
   */
  readonly platformTabs: AppRootTreeProps['platformTabs']
  /**
   * Whether a 401 that outlives the boot-race retry should redirect the user to
   * device login. Web entries set `true` (they have a device-login flow);
   * `main-tauri` sets `false` — the webview is host-authenticated, so there's no
   * user login to fall back to and driving the device flow would spawn a
   * spurious consent against the owner's own device. Keeping the choice a flag at
   * the entry seam keeps the platform decision out of an `entry`-string branch in
   * this shared code.
   */
  readonly redirectToDeviceLoginOnUnauthorized: boolean
  /**
   * Which kind of server the tree is for, and so which surfaces it offers.
   * `main-tauri` passes `ServerKind.Wildflower()`: its host is a Wildflower server.
   * `main-web` passes what its redeemed SMART sign-in found
   * (`sign-in.ts`'s `serverKindForSession`), and `ServerKind.Wildflower()` when no
   * sign-in was redeemed on this load — the shell is then reached only by the
   * device-code flow, which only a Wildflower server serves. Threaded into
   * router context for the route guards and the plain SMART Home, and into
   * the tree for `<TabBar>`.
   */
  readonly serverKind: ServerKind
  /**
   * Lazy bearer reader for `main-web`, the cross-origin entry. When provided,
   * every relative HTTP request carries `Authorization: Bearer <token>`.
   * Omitted for `main-tauri`, which the host authenticates.
   */
  readonly readBearer?: () => string | undefined
  /**
   * Token response handler for `main-web`. When provided,
   * `NeedsAuthMessage` writes the bearer and navigates client-side
   * instead of doing a full-page reload.
   */
  readonly tokenResponseHandler?: TokenResponseHandler
  /**
   * Why the web entry's boot-time SMART sign-in failed, when it did.
   * `main-web` redeems the authorization code before it mounts the router
   * (see its `boot`), so a failed return leg has nowhere to render itself by
   * the time the tree exists. Threaded into router context for the landing
   * route to show, the same way `localGrantedScopes` and `firstPartyClientId`
   * reach `NeedsAuthMessage`. Omitted on every other entry and on an ordinary
   * load. `sign-in.ts`'s `SignInProblem`, written out rather than imported:
   * this module is shared with the Tauri entry, which never signs in this way,
   * and `main-web` hands it the real type, so a drift fails to compile there.
   */
  readonly signInProblem?: { readonly reason: string; readonly serverUrl: string | undefined }
  /**
   * The directory this build is served from, as a router `basepath`, when the
   * copy is published under a subpath rather than at the origin root.
   *
   * `main-web` passes the served directory (e.g. `/staging/pr-42/app/` for a PR
   * preview, `/app/` for the hosted build) so the router strips it before
   * matching and re-adds it when it writes the address bar — otherwise every
   * root-absolute route (`/`, `/home`, …) misses under the subpath and the app
   * renders its own not-found. Omitted for `main-tauri`, served at the root,
   * where it defaults to `/` (a no-op).
   */
  readonly basepath?: string
}

/**
 * Build the app: its query runtime, transport and router, and the React tree
 * over them, ready to mount. Called once per entry point, by
 * {@link renderApp} or by an entry that mounts the tree inside its own root
 * (`main-web`, behind the telemetry consent gate).
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
 * Its boot-time handshake settles into `transportReady`, which
 * `awaitAuthReady` (the embedded factory) waits on internally — so
 * the embedded ordering ("transport ready before host pushes token")
 * is encoded inside `awaitAuthReady` itself rather than in a separate
 * `transportReady` field on router context.
 */
const buildAppTree = ({
  history,
  entry,
  tokenStore,
  awaitAuthReady,
  makeTransport,
  effectTelemetryLayer,
  apiBaseUrl,
  localGrantedScopes,
  firstPartyClientId,
  externalLinkRoot,
  platformSettingsItems,
  platformTabs,
  redirectToDeviceLoginOnUnauthorized,
  serverKind,
  readBearer,
  tokenResponseHandler,
  signInProblem,
  basepath,
}: RenderAppOptions): JSX.Element => {
  // Router isn't built until after the query runtime (its context needs the
  // runtime), so the closures that navigate imperatively read it through this
  // deferred cell, populated right after `createRouter`.
  const routerHandle: { current: AnyRouter | null } = { current: null }

  // Fires when an authed query/mutation ends in a 401 that outlived the
  // boot-race retry — the credential is genuinely gone, so send the user to
  // device login, preserving where they were as `returnTo`. The guard skips a
  // redundant navigation when they're already on the device-login route.
  const redirectToDeviceLogin = (): void => {
    const router = routerHandle.current
    if (router === null) return
    if (router.state.location.pathname === DEVICE_LOGIN_ROUTE) return
    void router.navigate(buildDeviceLoginTarget(router.state.location.href))
  }

  // Which 401 fallback this entry uses is the entry's decision, carried by the
  // `redirectToDeviceLoginOnUnauthorized` flag — not an `entry`-string branch
  // here. Web entries redirect; `main-tauri` takes no action (see the field doc
  // and the entrypoints). A new entry must state its own behavior at its seam.
  const onUnauthorized = redirectToDeviceLoginOnUnauthorized ? redirectToDeviceLogin : () => {}
  const { queryClient, runAuthed, runtimeLayer } = buildAppQueryRuntime(
    apiBaseUrl,
    onUnauthorized,
    effectTelemetryLayer,
    readBearer
  )

  // Keyed on the auth *signal* (the store), not the bearer source: on web a
  // sign-in flips the bearer store's signal and should flush the cache.
  forkTokenRotationInvalidator(tokenStore.subscribable, queryClient)

  // Built once per app. Only the Tauri host ever pushes
  // `PendingConsentRequested`, but the store and provider are wired in
  // every entry so the modal host's hook contract is identical
  // everywhere (no per-entry guard inside the gatekeeper-react surface).
  const activePendingConsentStore = makeActivePendingConsentStore()

  const transportPromise = makeTransport(
    tokenStore.setAuthState,
    activePendingConsentStore.setActiveHead
  )
  const transportReady = transportPromise.then(() => undefined)
  const resolvedAwaitAuthReady = awaitAuthReady(transportReady)

  const router = createRouter({
    routeTree,
    history,
    // A copy served under a subpath (a PR preview, or the hosted `/app/`) sets
    // this to its served directory so root-absolute routes resolve there; the
    // root-served entries omit it and it defaults to `/`. See
    // `RenderAppOptions.basepath`.
    basepath,
    context: {
      queryClient,
      runAuthed,
      runtimeLayer,
      awaitAuthReady: resolvedAwaitAuthReady,
      transport: transportPromise,
      entry,
      // Threaded so the apps launch POST reaches the host API origin — see
      // `RouterContext.apiBaseUrl`.
      apiBaseUrl,
      // Threaded so `NeedsAuthMessage` requests exactly gatekeeper's seeded
      // first-party scopes — see `RouterContext.localGrantedScopes`.
      localGrantedScopes,
      // Threaded so `NeedsAuthMessage`'s device-login `client_id` matches the id
      // gatekeeper seeds the first-party client under — see
      // `RouterContext.firstPartyClientId`.
      firstPartyClientId,
      // Threaded so `NeedsAuthMessage`'s pairing link opens on another device —
      // see `RouterContext.externalLinkRoot`.
      externalLinkRoot,
      // Threaded so the landing page can report a sign-in that failed before
      // the tree existed — see `RouterContext.signInProblem`.
      signInProblem,
      // Threaded so the auth-gated routes serve only this kind of server's
      // surfaces — see `RouterContext.serverKind`.
      serverKind,
    },
    defaultPreload: 'intent',
  })
  routerHandle.current = router

  return (
    <ErrorBoundary
      onError={(error, info) => {
        // oxlint-disable-next-line no-console
        console.error(`[${entry}] Uncaught error:`, error, info)
        // A no-op while Sentry has not been initialized: on `main-web`, until
        // the visitor's answer turns a switch on.
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
        <AuthStateProvider store={tokenStore}>
          <TokenResponseHandlerContext value={tokenResponseHandler}>
            <ActivePendingConsentProvider store={activePendingConsentStore}>
              <AppRootTree
                router={router}
                transportPromise={transportPromise}
                platformSettingsItems={platformSettingsItems}
                platformTabs={platformTabs}
                serverKind={serverKind}
              />
            </ActivePendingConsentProvider>
          </TokenResponseHandlerContext>
        </AuthStateProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}

/**
 * Mount `appTree` under the page's `#root`, in `StrictMode`.
 *
 * @throws When the page has no `#root` element
 */
const mountAtRoot = (appTree: ReactNode): void => {
  const container = document.getElementById('root')
  if (container === null) {
    throw new Error('root element not found')
  }
  createRoot(container).render(<StrictMode>{appTree}</StrictMode>)
}

/**
 * Build the app with {@link buildAppTree} and mount it under `#root`: the
 * whole boot of an entry that asks nothing first (`main-tauri`).
 */
const renderApp = (options: RenderAppOptions): void => {
  mountAtRoot(buildAppTree(options))
}

export { buildAppTree, forkTokenRotationInvalidator, mountAtRoot, renderApp }
export type { MakeAwaitAuthReady, MakeTransport, RenderAppOptions }
