import { HttpClient, HttpClientResponse } from '@effect/platform'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Effect, Layer } from 'effect'
import { useEffect, type JSX, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

/**
 * Regression guard for the PR that migrated react-router → TanStack and
 * SPLIT the provider stack across two homes:
 *
 *  - `<RootShell>` — the TanStack root-route `component`. Renders ONLY
 *    the slice client providers (gatekeeper → collector → fhir-r4 →
 *    apps) around `<Outlet />`. (Tunnel's client provider was dropped in
 *    the TanStack-Query migration — Issue #101 Phase 1.)
 *  - `app-root.tsx`'s `InnerWrap` — passed to `<RouterProvider>`. Renders
 *    the auth/runtime/transport/sender stack (AuthTokenProvider, the two
 *    RuntimeProviders, TransportProvider, the two SenderForwarders)
 *    ABOVE the router's matched routes.
 *
 * The invariant both halves share: TanStack's `<RouterProvider>` does NOT
 * remount the root-route component OR the `InnerWrap` on child
 * navigations — children mount/unmount inside the `<Outlet />` — so both
 * provider tiers keep state across nav. That's the whole reason it's safe
 * to host `BridgeTransport` (built via `useNavigate()` / `useRouter()`)
 * in the `InnerWrap`: a remount would tear down and rebuild the transport
 * on every navigation, dropping pending bridge messages and breaking the
 * `__Ready` handshake.
 *
 * The two describe blocks below pin each tier:
 *  - "RootShell mount lifecycle" mounts `<RootShell>` directly as a
 *    root-route component and asserts its slice client providers stay
 *    mounted across navigation.
 *  - "renderApp InnerWrap lifecycle" exercises the real `renderApp`
 *    (with `InnerWrap`) and asserts the relocated auth/runtime/transport
 *    stack mounts and is left untouched by navigation.
 *
 * Strategy (shared): mock every provider/bridge as an identity
 * passthrough that records `'mount'` / `'unmount'` events into a shared
 * `lifecycleSpy`, so the test exercises only mount semantics — not the
 * Effect runtimes, BridgeTransport build, or console interceptors the
 * real stack pulls in. The recorded event log distinguishes "the
 * provider stayed put" (its log is unchanged by navigation) from "the
 * stack rebuilt under the new route" (mount + unmount appended on nav).
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
}))
// `renderApp` reads the token via `Effect.runSync(authTokenRef.get)` to
// gate the eager startup prefetch, so `get` must be an Effect (not a
// plain value). A null-token ref keeps the prefetch short-circuited.
vi.mock('gatekeeper-react', () => ({
  authTokenRef: { get: Effect.succeed(null), changes: { pipe: () => ({}) } },
  GatekeeperClientProvider: makePassthrough('GatekeeperClientProvider'),
}))
vi.mock('collector-react', () => ({
  CollectorClientProvider: makePassthrough('CollectorClientProvider'),
  CollectorRuntimeProvider: makePassthrough('CollectorRuntimeProvider'),
}))
vi.mock('fhir-r4-react', () => ({
  FhirR4ResourcesClientProvider: makePassthrough('FhirR4ResourcesClientProvider'),
}))
vi.mock('apps-react', () => ({
  AppsClientProvider: makePassthrough('AppsClientProvider'),
  AppsRuntimeProvider: makePassthrough('AppsRuntimeProvider'),
}))
// `renderApp` builds the router context's `runAuthed` and eagerly
// prefetches the tunnel state query (`tunnelStateQueryOptions`) at
// startup. The prefetch is gated on a token in `authTokenRef`, and the
// mocked `gatekeeper-react` ref below reports `null` — so the prefetch
// short-circuits and `tunnelStateQueryOptions` is never invoked. Stub it
// to a no-throw factory so the import resolves without dragging the
// tunnel HttpApi client into the harness.
vi.mock('tunnel-react', () => ({
  tunnelStateQueryOptions: () => ({ queryKey: ['tunnel', 'state'], queryFn: () => null }),
}))
vi.mock('../src/bridges/collector-sender-forwarder.tsx', () => ({
  CollectorSenderForwarder: makePassthrough('CollectorSenderForwarder'),
}))
vi.mock('../src/bridges/apps-sender-forwarder.tsx', () => ({
  AppsSenderForwarder: makePassthrough('AppsSenderForwarder'),
}))
// `renderApp` wraps the tree in `telemetry-web`'s `<ErrorBoundary>` and
// reports to `Sentry`. Neither is the thing under test, and the real
// `ErrorBoundary` would mask assertion failures by swallowing them into
// Sentry — so reduce the boundary to a passthrough and `Sentry` to a
// no-op.
vi.mock('telemetry-web', () => ({
  ErrorBoundary: ({ children }: { readonly children?: ReactNode }): JSX.Element => <>{children}</>,
  Sentry: { captureException: () => {} },
}))
// `renderApp` builds the router context's `runAuthed` via
// `buildRunAuthed(authTokenRef, webHttpClientLayer)`. The real
// `webHttpClientLayer` pulls `telemetry-react` → `telemetry-web`'s
// `webTelemetryLayerFromEnv`, which the `telemetry-web` mock above does
// NOT provide (and which is not this block's concern — no loader invokes
// `runAuthed`). Stub the layer to a bare `HttpClient` so the authed
// runtime constructs without dragging telemetry/fetch into the harness.
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
// imported (inside the test's `await import('../src/app-root.tsx')`),
// long after this module finished evaluating — so it can close over the
// `RootShell` import and the `LeafA` / `LeafB` consts declared below.
vi.mock('../src/routeTree.gen.ts', () => {
  const rootRoute = createRootRoute({ component: RootShell })
  const routeA = createRoute({ getParentRoute: () => rootRoute, path: '/a', component: LeafA })
  const routeB = createRoute({ getParentRoute: () => rootRoute, path: '/b', component: LeafB })
  return { routeTree: rootRoute.addChildren([routeA, routeB]) }
})

// Imported AFTER the vi.mock calls so the mocks intercept the
// transitive imports of `RootShell` and `renderApp`. (Vitest hoists
// `vi.mock` above this line at compile time, so the static `import`
// order here is just for human readers.)
import { RootShell } from '../src/session/root-shell.tsx'

const LeafA = (): JSX.Element => <div data-testid="leaf-a">A</div>
const LeafB = (): JSX.Element => <div data-testid="leaf-b">B</div>

const lifecycleEventsFor = (name: string): readonly ('mount' | 'unmount')[] =>
  lifecycleSpy.mock.calls
    .filter(([, providerName]) => providerName === name)
    .map(([event]) => event)

// TanStack Router's scroll-restoration runs on every navigation and
// calls `window.scrollTo`, which jsdom logs as "Not implemented:
// window.scrollTo" through `console.error`. The behavior is irrelevant
// to these regression guards, so suppress the noise to keep the test
// output focused on real failures.
const silenceScrollTo = (): void => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
}

describe('RootShell mount lifecycle', () => {
  // The five slice client providers `RootShell` actually renders, from
  // outermost to innermost. The relocated auth/runtime/transport/sender
  // providers are NOT here — they live in `app-root.tsx`'s `InnerWrap`
  // and are covered by the "renderApp InnerWrap lifecycle" block below.
  const ROOT_SHELL_PROVIDERS = [
    'GatekeeperClientProvider',
    'CollectorClientProvider',
    'FhirR4ResourcesClientProvider',
    'AppsClientProvider',
  ] as const

  const buildTestRouter = (): ReturnType<typeof createRouter> => {
    // RootShell renders its own `<Outlet />`, so we mount it directly as
    // the root-route component — the same wiring as `__root.tsx`.
    const rootRoute = createRootRoute({ component: RootShell })
    const routeA = createRoute({ getParentRoute: () => rootRoute, path: '/a', component: LeafA })
    const routeB = createRoute({ getParentRoute: () => rootRoute, path: '/b', component: LeafB })
    const routeTree = rootRoute.addChildren([routeA, routeB])
    return createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/a'] }),
    })
  }

  // Vitest does NOT clean up the rendered DOM between tests by default,
  // and both tests below render their own router into the shared jsdom
  // body — without an explicit cleanup the second test would observe
  // the first test's elements alongside its own and fail `getByTestId`
  // with a "multiple elements" match. Running `cleanup()` here also
  // fires React's unmount effects, which flush a final 'unmount' event
  // per provider into `lifecycleSpy` — `mockClear` in the next test's
  // setup discards those before any assertion runs.
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    silenceScrollTo()
    lifecycleSpy.mockClear()
  })

  test('navigating between sibling routes leaves the outermost provider mounted', async () => {
    const router = buildTestRouter()

    render(<RouterProvider router={router} />)

    // First match resolves asynchronously under `<RouterProvider>`; the
    // root-route component renders before the leaf, but the spy call
    // lives in `useEffect`, so wait for the leaf to confirm the tree
    // settled.
    await waitFor(() => {
      expect(screen.getByTestId('leaf-a')).toBeDefined()
    })

    // The outermost provider `RootShell` actually renders is
    // `GatekeeperClientProvider`: if anything ABOVE the Outlet remounts
    // (or unmounts and never remounts), its event log diverges from a
    // single `['mount']`. Other providers might wobble in subtle
    // refactors, but the outer one is the regression-grade indicator.
    expect(lifecycleEventsFor('GatekeeperClientProvider')).toEqual(['mount'])

    // Navigate to a sibling. If `RootShell` were promoted to a child
    // route whose path stops matching at `/b`, this would unmount the
    // whole stack — surfacing as an `'unmount'` event tail.
    await act(async () => {
      await router.navigate({ to: '/b' })
    })

    await waitFor(() => {
      expect(screen.getByTestId('leaf-b')).toBeDefined()
    })
    // Leaf A is gone — confirms the Outlet actually swapped children,
    // so the navigation was real (not a no-op masking the assertion).
    expect(screen.queryByTestId('leaf-a')).toBeNull()

    // Pin: still exactly one mount, no unmounts of the outermost
    // provider.
    expect(lifecycleEventsFor('GatekeeperClientProvider')).toEqual(['mount'])
  })

  test('no slice client provider unmounts or remounts across navigation', async () => {
    // Broader assertion: every passthrough `RootShell` renders sees
    // exactly `['mount']` — no remounts (would mean the stack rebuilt
    // under a new parent route) and no unmounts (would mean the parent
    // route stopped matching). The all-providers sweep catches the
    // subtle regression mode where the stack splits and some providers
    // migrate into a sub-component that remounts.
    const router = buildTestRouter()

    render(<RouterProvider router={router} />)
    await waitFor(() => {
      expect(screen.getByTestId('leaf-a')).toBeDefined()
    })

    for (const name of ROOT_SHELL_PROVIDERS) {
      expect(lifecycleEventsFor(name)).toEqual(['mount'])
    }

    await act(async () => {
      await router.navigate({ to: '/b' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('leaf-b')).toBeDefined()
    })

    for (const name of ROOT_SHELL_PROVIDERS) {
      expect(lifecycleEventsFor(name)).toEqual(['mount'])
    }
  })
})

describe('renderApp InnerWrap lifecycle', () => {
  // The six providers that moved OUT of `RootShell` and into
  // `app-root.tsx`'s `InnerWrap` (`AuthTokenProvider` wraps
  // `<RouterProvider>` from just above it; the rest nest inside
  // `InnerWrap`). This is the auth/runtime/transport stack the migration
  // relocated, and the tier this block exists to pin.
  const INNER_WRAP_PROVIDERS = [
    'AuthTokenProvider',
    'CollectorRuntimeProvider',
    'AppsRuntimeProvider',
    'TransportProvider',
    'CollectorSenderForwarder',
    'AppsSenderForwarder',
  ] as const

  // `renderApp` mounts into `document.getElementById('root')` via
  // `createRoot`, so the container must exist before each render and be
  // torn down (with its React root) afterwards — otherwise a second
  // `createRoot` on the same node warns and the prior tree's elements
  // linger in the shared jsdom body.
  beforeEach(() => {
    silenceScrollTo()
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
    const { renderApp } = await import('../src/app-root.tsx')
    const history = createMemoryHistory({ initialEntries: ['/a'] })

    await act(async () => {
      renderApp({
        history,
        TransportProvider: makePassthrough('TransportProvider'),
        entry: 'main-web',
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
