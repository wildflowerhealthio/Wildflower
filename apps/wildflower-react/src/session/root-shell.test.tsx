import { HttpClient, HttpClientResponse } from '@effect/platform'
import { createMemoryHistory, createRootRoute, createRoute } from '@tanstack/react-router'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { Effect, Layer, SubscriptionRef } from 'effect'
import { useEffect, type JSX, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

/**
 * Regression guard for the provider tier that lives above the router.
 * `<RootShell>` renders ONLY an `<Outlet />` — no slice client providers
 * nest there. The stack lives in two places:
 *
 *  - Above `<RouterProvider>`: `AuthTokenProvider` and the in-tree
 *    `TransportContext.Provider` (the value is seeded by a promise
 *    resolved outside React; the tree itself doesn't build the
 *    transport).
 *  - `InnerWrap` (passed to `<RouterProvider>`): `CollectorSenderForwarder`
 *    — a slice sender that closes over `useBridgeTransport`.
 *
 * The invariant: TanStack's `<RouterProvider>` does NOT remount the
 * `InnerWrap` on child navigations — children mount/unmount inside the
 * `<Outlet />` — so the provider tier keeps state across nav.
 *
 * Strategy: mock every provider/bridge as an identity passthrough that
 * records `'mount'` / `'unmount'` events into a shared `lifecycleSpy`,
 * so the test exercises only mount semantics — not Effect runtimes or
 * console interceptors. The event log distinguishes "the provider
 * stayed put" (log unchanged by nav) from "rebuilt under the new
 * route" (mount + unmount appended).
 */

// `vi.hoisted` lifts these declarations above the `vi.mock` factory
// invocations (Vitest hoists `vi.mock` to the top of the file, so any
// non-hoisted reference inside a factory would be a temporal-dead-zone
// crash at module load).
const { lifecycleSpy, makePassthrough } = vi.hoisted(() => {
  const spy = vi.fn<(event: 'mount' | 'unmount', providerName: string) => void>()
  const factory = (name: string): ((props: { readonly children?: ReactNode }) => JSX.Element) => {
    const Passthrough = ({ children }: { readonly children?: ReactNode }): JSX.Element => {
      // `useEffect(..., [])` mount + cleanup pair — records mount on
      // first commit and unmount on cleanup. Recording both halves
      // catches the regression mode where a layout-route promotion
      // tears down the stack on navigation (an unmount event without a
      // corresponding remount would still appear here even if the new
      // route doesn't re-render the providers).
      useEffect(() => {
        spy('mount', name)
        return () => {
          spy('unmount', name)
        }
      }, [])
      return <>{children}</>
    }
    Passthrough.displayName = `MockPassthrough(${name})`
    return Passthrough
  }
  return { lifecycleSpy: spy, makePassthrough: factory }
})

// Mock every slice provider package and every app-local bridge file as
// a passthrough. Mocks only need to satisfy the surface the modules
// under test import. `authTokenRef` is a non-component export and is
// reduced to a stub `Subscribable` that reports null and never
// publishes — the mocked AuthTokenProvider doesn't use it.
vi.mock('react-kitchen-sink', () => ({
  AuthTokenProvider: makePassthrough('AuthTokenProvider'),
  // Mirror the real `cn` helper so the ErrorBoundary in `renderApp`'s
  // tree (`react-tundraish` reads `cn` via this re-export) doesn't
  // crash if the rendered subtree throws.
  cn: (
    ...args: ReadonlyArray<string | undefined | null | false | Record<string, boolean>>
  ): string => args.filter((a): a is string => typeof a === 'string').join(' '),
  // `AppRootTree` consumes the transport promise through this hook;
  // resolve immediately to the fallback so the test renders past the
  // suspense window.
  usePromiseOrDefault: <T,>(_promise: Promise<T>, fallback: T): T => fallback,
}))
// The `RootShell` lifecycle test only consumes the slice runtime
// layer; the `AuthTokenStore` itself is constructed inline in the
// test body below. `ActiveDeviceUserCodeProvider` is reduced to a
// passthrough and `DeviceConsentModalHost` to nothing — the popup
// surface isn't what's being pinned here, and the real Effect
// `SubscriptionRef` plumbing would drag a runtime into this harness.
vi.mock('gatekeeper-react', () => ({
  GatekeeperRouterContext: { sliceRuntimeLayer: Layer.empty },
  ActiveDeviceUserCodeProvider: makePassthrough('ActiveDeviceUserCodeProvider'),
  makeActiveDeviceUserCodeStore: () => ({
    subscribable: {
      get: Effect.succeed(null),
      changes: { pipe: () => ({}) },
    },
    setActiveUserCode: () => {},
  }),
  DeviceConsentModalHost: (): null => null,
}))
vi.mock('collector-react', () => ({
  CollectorRouterContext: { sliceRuntimeLayer: Layer.empty },
}))
// fhir-r4-react no longer ships a client provider — the app composes its
// `sliceRuntimeLayer` into the runtime layer (see `router-context.ts`),
// so the mock now mirrors the other migrated slices' router-context shape.
vi.mock('fhir-r4-react', () => ({
  FhirR4ResourcesRouterContext: { sliceRuntimeLayer: Layer.empty },
}))
vi.mock('apps-react', () => ({
  AppsRouterContext: { sliceRuntimeLayer: Layer.empty },
}))
// Prefetch is gated off (null token); these stubs keep the import light.
vi.mock('tunnel-react', () => ({
  tunnelStateQueryOptions: () => ({ queryKey: ['tunnel', 'state'], queryFn: () => null }),
  TunnelRouterContext: { sliceRuntimeLayer: Layer.empty },
}))
vi.mock('../bridges/collector-sender-forwarder.tsx', () => ({
  CollectorSenderForwarder: makePassthrough('CollectorSenderForwarder'),
}))
// `renderApp` wraps the tree in `telemetry-web`'s `<ErrorBoundary>` and
// reports to `Sentry`. Neither is the thing under test, and the real
// `ErrorBoundary` would mask assertion failures by swallowing them into
// Sentry — so reduce the boundary to a passthrough and `Sentry` to a
// no-op.
vi.mock('telemetry-web', () => ({
  ErrorBoundary: ({ children }: { readonly children?: ReactNode }): JSX.Element => <>{children}</>,
  Sentry: { captureException: () => {} },
  webTelemetryLayerFromEnv: () => Layer.empty,
}))
// Bare `HttpClient` so the authed runtime constructs without telemetry/fetch.
vi.mock('telemetry-react', () => ({
  webHttpClientLayer: Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
    )
  ),
}))
// `renderApp` imports the real `routeTree.gen.ts`, whose top-level
// imports eagerly pull in every slice's route screens (Effect HttpApi
// clients, CSS modules, sync runners). Those modules are incidental to
// the `InnerWrap` wiring the "renderApp InnerWrap lifecycle" block
// pins, and would drag network/Effect machinery into the harness — so
// swap the generated tree for a minimal one built from the real
// `__root` route (`RootShell`, already mocked down to passthroughs)
// plus two leaf routes. The router still mounts through the real
// `renderApp` + `InnerWrap`, which is the thing being pinned.
//
// `@tanstack/react-router` is not mocked, so the `createRootRoute` /
// `createRoute` imported at the top of this file are the real builders.
// The factory runs lazily — only when `routeTree.gen.ts` is first
// imported (inside the test's `await import('../app-root.tsx')`),
// long after this module finished evaluating — so it can close over the
// `RootShell` import and the `LeafA` / `LeafB` consts declared below.
vi.mock('../routeTree.gen.ts', () => {
  const rootRoute = createRootRoute({ component: RootShell })
  const routeA = createRoute({ getParentRoute: () => rootRoute, path: '/a', component: LeafA })
  const routeB = createRoute({ getParentRoute: () => rootRoute, path: '/b', component: LeafB })
  return { routeTree: rootRoute.addChildren([routeA, routeB]) }
})

// Imported AFTER the vi.mock calls so the mocks intercept the
// transitive imports of `RootShell` and `renderApp`. (Vitest hoists
// `vi.mock` above this line at compile time, so the static `import`
// order here is just for human readers.)
import { RootShell } from './root-shell.tsx'

const LeafA = (): JSX.Element => <div data-testid="leaf-a">A</div>
const LeafB = (): JSX.Element => <div data-testid="leaf-b">B</div>

const lifecycleEventsFor = (name: string): readonly ('mount' | 'unmount')[] =>
  lifecycleSpy.mock.calls
    .filter(([, providerName]) => providerName === name)
    .map(([event]) => event)

describe('renderApp InnerWrap lifecycle', () => {
  // The providers that live around the router above its matched routes:
  // `AuthTokenProvider` (just above `<RouterProvider>`) and the
  // `CollectorSenderForwarder` slice sender that nests inside `InnerWrap`.
  // The `TransportContext.Provider` is also above the router (in `AppRoot`)
  // but is a plain context provider with no React-tree work to pin.
  const INNER_WRAP_PROVIDERS = ['AuthTokenProvider', 'CollectorSenderForwarder'] as const

  // `renderApp` mounts into `document.getElementById('root')` via
  // `createRoot`, so the container must exist before each render and be
  // torn down (with its React root) afterwards — otherwise a second
  // `createRoot` on the same node warns and the prior tree's elements
  // linger in the shared jsdom body.
  beforeEach(() => {
    lifecycleSpy.mockClear()
    const container = document.createElement('div')
    container.id = 'root'
    document.body.appendChild(container)
  })

  afterEach(() => {
    cleanup()
    document.getElementById('root')?.remove()
    vi.restoreAllMocks()
  })

  test('the relocated auth/runtime/transport stack mounts once and survives navigation', async () => {
    const { renderApp } = await import('../app-root.tsx')
    const history = createMemoryHistory({ initialEntries: ['/a'] })

    const { stubTransport } = await import('../bridges/transport-context.ts')
    // Minimal in-memory `AuthTokenStore` — this test is about provider
    // lifetimes across navigation, not the bearer itself.
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>(null))
    const tokenStore = {
      subscribable: tokenRef,
      setToken: (t: string | null): void => Effect.runSync(SubscriptionRef.set(tokenRef, t)),
    }
    await act(async () => {
      renderApp({
        history,
        entry: 'main-web',
        tokenStore,
        awaitAuthReady: () => () => Promise.resolve(),
        makeTransport: () => Promise.resolve(stubTransport),
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('leaf-a')).toBeDefined()
    })

    // `renderApp` wraps in `<StrictMode>`, which double-invokes mount
    // effects on the initial commit — so each provider's initial log is
    // `['mount', 'unmount', 'mount']`, not `['mount']`. The invariant
    // under test is NOT "exactly one mount" (that's StrictMode's call)
    // but "navigation leaves the log untouched": capture the settled
    // snapshot, navigate, and assert the log is byte-for-byte identical
    // after. Pinning stability across nav isolates the regression
    // cleanly without coupling to StrictMode's mount-count semantics.
    const beforeNav = Object.fromEntries(
      INNER_WRAP_PROVIDERS.map((name) => [name, lifecycleEventsFor(name)])
    )
    // Every relocated provider must be present (mounted at least once)
    // before navigation — guards against the snapshot silently being
    // empty if a provider were dropped from the `InnerWrap`.
    for (const name of INNER_WRAP_PROVIDERS) {
      expect(beforeNav[name]).toContain('mount')
    }

    // `history.push` is synchronous; the router subscribes to the
    // history and re-renders its `<Outlet />`. Wrapping in `act` flushes
    // the resulting state update so the assertions see the settled tree.
    await act(async () => {
      history.push('/b')
    })

    await waitFor(() => {
      expect(screen.getByTestId('leaf-b')).toBeDefined()
    })
    // Leaf A is gone — confirms the Outlet actually swapped children,
    // so the navigation was real (not a no-op masking the assertion).
    expect(screen.queryByTestId('leaf-a')).toBeNull()

    // The relocated stack is left untouched by navigation: no provider's
    // log gained a trailing unmount/remount. A layout-route regression
    // that pushed any of these below the router's stable boundary would
    // append `'unmount', 'mount'` here.
    for (const name of INNER_WRAP_PROVIDERS) {
      expect(lifecycleEventsFor(name)).toEqual(beforeNav[name])
    }
  })
})
