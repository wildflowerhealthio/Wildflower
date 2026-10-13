import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { type AnyRouter, createRouter, type RouterHistory } from '@tanstack/react-router'
import {
  type BearerAuthStateStore,
  buildDeviceLoginTarget,
  DEVICE_LOGIN_ROUTE,
  TokenResponseHandlerContext,
  type TokenResponseHandler,
} from '@wildflowerhealthio/gatekeeper-react'
import { type AuthState, AuthStateProvider } from '@wildflowerhealthio/react-kitchen-sink'
import { ErrorBoundary } from '@wildflowerhealthio/react-tundraish'
import { Sentry } from '@wildflowerhealthio/telemetry-web'
import { Effect, type Fiber, type Layer, type Subscribable, Stream } from 'effect'
import { StrictMode, type JSX, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { buildAppQueryRuntime } from './bridges/app-query-runtime.ts'
import { AppRootTree } from './bridges/app-root-tree.tsx'
import type { RouterContext } from './router-context.ts'
import { routeTree } from './routeTree.gen.ts'
import { logoutSettingsItem, underBasepath } from './web-entry.ts'
// The design-system stylesheet stack, fonts included — imported here so the
// app picks it up. An entry that already imported part of it gets no second
// copy: the bundler dedupes each stylesheet by module id.
import '@wildflowerhealthio/react-tundraish/styles'

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
  /** The browser history the router reads and writes. */
  readonly history: RouterHistory
  /**
   * The page's {@link BearerAuthStateStore}: the session a sign-in writes, the
   * server and bearer every API request reads (see `apiTransport`), and the
   * auth signal threaded into `<AuthStateProvider>` for descendants and into a
   * token-rotation invalidator that flushes TanStack Query's cache when the
   * signal changes (so 401-pinned entries don't outlive a sign-in or
   * rotation). `main-web` passes `makeBearerAuthStateStore` over the tab's
   * `sessionStorage`; tests pass fakes.
   */
  readonly tokenStore: BearerAuthStateStore
  /**
   * The auth-readiness wait the gated routes' `beforeLoad` calls, threaded
   * into router context. `main-web` passes gatekeeper-react's
   * `makeAwaitLandingAuthReady` over `tokenStore`; tests pass fakes.
   */
  readonly awaitAuthReady: RouterContext['awaitAuthReady']
  /**
   * The Effect telemetry layer every authed request runs under, binding its
   * spans to the page's tracer provider. `main-web` passes `telemetry-web`'s
   * `consentedTelemetryLayer`, empty until the user's answer to the consent
   * dialog turns performance on.
   */
  readonly effectTelemetryLayer: Layer.Layer<never>
  /**
   * Where a link meant for another device points, before the router basepath.
   * Threaded into router context for `NeedsAuthMessage`'s device-flow pairing
   * link — see `RouterContext.externalLinkRoot`.
   */
  readonly externalLinkRoot: () => string
  /**
   * Which kind of server the tree is for, and so which surfaces it offers:
   * what the sign-in redeemed on this load found (`sign-in.ts`'s
   * `serverKindForSession`), and `ServerKind.Wildflower()` when no sign-in was
   * redeemed on this load — the shell is then reached only by the device-code
   * flow, which only a Wildflower server serves. Threaded into router context
   * for the route guards and the plain SMART Home.
   */
  readonly serverKind: RouterContext['serverKind']
  /**
   * Why the boot-time SMART sign-in failed, when it did. `main-web` redeems
   * the authorization code before it mounts the router (see its `boot`), so a
   * failed return leg has nowhere to render itself by the time the tree
   * exists. Threaded into router context for the landing route to show.
   * Omitted on an ordinary load.
   */
  readonly signInProblem?: RouterContext['signInProblem']
  /**
   * The SMART EHR launch the page load was opened with, until a sign-in takes
   * it. `main-web` reads it from the URL at boot and takes it out of the
   * address bar; threaded into router context for the landing route to sign
   * in with on arrival. Omitted on a load that carried none.
   */
  readonly ehrLaunch?: RouterContext['ehrLaunch']
  /**
   * The directory this build is served from, as a router `basepath`, when the
   * copy is published under a subpath rather than at the origin root.
   *
   * `main-web` passes the served directory (e.g. `/staging/pr-42/launcher/` for a PR
   * preview, `/launcher/` for the hosted build) so the router strips it before
   * matching and re-adds it when it writes the address bar — otherwise every
   * root-absolute route (`/`, `/home`, …) misses under the subpath and the app
   * renders its own not-found. Omitted, it is `/`.
   */
  readonly basepath?: string
}

/**
 * The page's {@link TokenResponseHandler}, for `NeedsAuthMessage`'s device
 * flow: write the token as the session's, on the server the session already
 * names, and navigate to `returnTo` under `basepath` without reloading (a
 * reload would drop the in-memory bearer).
 *
 * @throws When a token arrives while no server is signed in to: device login
 *   runs against the session's server, whose requests go nowhere without one,
 *   so a token always has a server to belong to.
 */
const deviceFlowTokenResponseHandler = (
  tokenStore: BearerAuthStateStore,
  history: RouterHistory,
  basepath: string
): TokenResponseHandler => ({
  writeBearer: (accessToken) => {
    const serverUrl = tokenStore.serverUrl()
    if (serverUrl === undefined) {
      throw new Error('a device-login token arrived with no server signed in to')
    }
    tokenStore.writeSession({ serverUrl, bearer: accessToken })
  },
  navigateAfterAuth: (returnTo) => {
    // `history.push` writes the address bar directly and does not apply the
    // router basepath (that is `router.navigate`'s job), so the served base
    // is prefixed here — otherwise the device-login return lands at
    // `<origin>/home`, off the app, on a subpath deploy.
    history.push(underBasepath(basepath, returnTo))
  },
})

/**
 * Build the app: its query runtime and router, and the React tree over them,
 * ready to mount. Called once, from the `bootApp` `main-web` hands
 * `ConsentedEntryRoot`, behind the telemetry consent gate.
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
 * The settings screen's Logout row is gatekeeper's, over `tokenStore`: it
 * revokes the bearer at the session's server, clears the tab's
 * `sessionStorage` (the session's server included) and reloads the bare
 * landing page at `basepath`, so the reader picks a server rather than being
 * signed straight back in.
 */
const buildAppTree = ({
  history,
  tokenStore,
  awaitAuthReady,
  effectTelemetryLayer,
  externalLinkRoot,
  serverKind,
  signInProblem,
  ehrLaunch,
  basepath = '/',
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

  const { queryClient, runAuthed, runtimeLayer } = buildAppQueryRuntime(
    tokenStore,
    redirectToDeviceLogin,
    effectTelemetryLayer
  )

  // Keyed on the auth *signal* (the store), not the bearer: a sign-in flips
  // the store's signal and should flush the cache.
  forkTokenRotationInvalidator(tokenStore.subscribable, queryClient)

  const router = createRouter({
    routeTree,
    history,
    // A copy served under a subpath (a PR preview, or the hosted `/launcher/`) sets
    // this to its served directory so root-absolute routes resolve there. See
    // `RenderAppOptions.basepath`.
    basepath,
    context: {
      queryClient,
      runAuthed,
      runtimeLayer,
      awaitAuthReady,
      // Threaded so `NeedsAuthMessage`'s pairing link opens on another device —
      // see `RouterContext.externalLinkRoot`.
      externalLinkRoot,
      // Threaded so the landing page can report a sign-in that failed before
      // the tree existed — see `RouterContext.signInProblem`.
      signInProblem,
      // Threaded so the landing page can sign in with the EHR launch the page
      // was opened with — see `RouterContext.ehrLaunch`.
      ehrLaunch,
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
        console.error('[launcher-web] Uncaught error:', error, info)
        // A no-op while Sentry has not been initialized: until the visitor's
        // answer turns a switch on.
        Sentry.captureException(error, {
          extra: { componentStack: info.componentStack ?? undefined },
        })
      }}
      extraContext={{
        mode: import.meta.env.MODE,
      }}
    >
      <QueryClientProvider client={queryClient}>
        <AuthStateProvider store={tokenStore}>
          <TokenResponseHandlerContext
            value={deviceFlowTokenResponseHandler(tokenStore, history, basepath)}
          >
            <AppRootTree
              router={router}
              logoutSettingsItem={logoutSettingsItem(window, basepath, tokenStore)}
            />
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

export { buildAppTree, forkTokenRotationInvalidator, mountAtRoot }
export type { RenderAppOptions }
