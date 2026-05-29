import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useEffect, type JSX, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

/**
 * Regression guard for the PR that relocated the provider stack into a
 * TanStack root-route component (`<RootShell>`):
 *
 * TanStack's `<RouterProvider>` does NOT remount the root route's
 * component on child navigations — children mount/unmount inside its
 * `<Outlet />` — so the provider stack keeps state across nav. That's
 * the whole reason it's safe to host `BridgeTransport` (built via
 * `useNavigate()` / `useRouter()`) inside the stack: a remount would
 * tear down and rebuild the transport on every navigation, dropping
 * pending bridge messages and breaking the `__Ready` handshake.
 *
 * The risk this test pins: a future refactor could accidentally
 * promote `RootShell` from the root-route `component` to a layout
 * route's `component` (`createRoute({ id: '_shell', component: RootShell })`),
 * which WOULD remount on navigation. There's no type-level signal that
 * would catch this, hence the runtime assertion.
 *
 * Strategy:
 *  - Mock every provider/bridge in the stack as an identity passthrough
 *    so the test exercises only the mount semantics — not the Effect
 *    runtimes, BridgeTransport build, or console interceptors that the
 *    real stack pulls in. Each passthrough records `'mount'` /
 *    `'unmount'` events into a shared `lifecycleSpy`, so the assertions
 *    can distinguish "the stack stayed mounted" (one mount, no
 *    unmounts) from "the stack rebuilt under the new route" (mount +
 *    unmount + mount) or "the stack tore down without rebuilding"
 *    (mount + unmount). The canonical signal is the outermost provider
 *    (`AuthTokenProvider`); the broader assertion sweeps every
 *    provider to catch subtler regressions where only part of the
 *    stack migrates into a remount-prone sub-component.
 *  - Build a memory-history router with `<RootShell>` as the root
 *    component and two distinct child routes, then navigate between
 *    them.
 *  - Assert each provider's recorded event log is exactly `['mount']`
 *    before AND after navigation. Under StrictMode this would be
 *    `['mount', 'unmount', 'mount']`, but the test doesn't wrap in
 *    StrictMode for that exact reason — what we want to guard is
 *    "navigation does not bump the lifecycle counts", which isolates
 *    the regression cleanly.
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
// a passthrough. Mocks only need to satisfy the surface `RootShell`
// imports (one named export per file). `authTokenRef` is the lone
// non-component export and is reduced to a stub `Subscribable` that
// reports null and never publishes — the mocked AuthTokenProvider
// doesn't use it.
vi.mock('react-kitchen-sink', () => ({
  AuthTokenProvider: makePassthrough('AuthTokenProvider'),
}))
vi.mock('gatekeeper-react', () => ({
  authTokenRef: { get: () => null, subscribe: () => () => {} },
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
vi.mock('tunnel-react', () => ({
  TunnelClientProvider: makePassthrough('TunnelClientProvider'),
}))
vi.mock('../src/bridges/transport-provider.tsx', () => ({
  TransportProvider: makePassthrough('TransportProvider'),
}))
vi.mock('../src/bridges/collector-sender-forwarder.tsx', () => ({
  CollectorSenderForwarder: makePassthrough('CollectorSenderForwarder'),
}))
vi.mock('../src/bridges/apps-sender-forwarder.tsx', () => ({
  AppsSenderForwarder: makePassthrough('AppsSenderForwarder'),
}))

// Imported AFTER the vi.mock calls so the mocks intercept RootShell's
// transitive imports. (Vitest hoists `vi.mock` above this line at
// compile time, so the static `import` order here is just for human
// readers.)
import { RootShell } from '../src/session/root-shell.tsx'

const LeafA = (): JSX.Element => <div data-testid="leaf-a">A</div>
const LeafB = (): JSX.Element => <div data-testid="leaf-b">B</div>

const buildTestRouter = (): ReturnType<typeof createRouter> => {
  // RootShell renders its own `<Outlet />`, so we mount it directly as
  // the root-route component — the same wiring as `routes.tsx`.
  const rootRoute = createRootRoute({ component: RootShell })
  const routeA = createRoute({ getParentRoute: () => rootRoute, path: '/a', component: LeafA })
  const routeB = createRoute({ getParentRoute: () => rootRoute, path: '/b', component: LeafB })
  const routeTree = rootRoute.addChildren([routeA, routeB])
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/a'] }),
  })
}

const lifecycleEventsFor = (name: string): readonly ('mount' | 'unmount')[] =>
  lifecycleSpy.mock.calls
    .filter(([, providerName]) => providerName === name)
    .map(([event]) => event)

const ALL_PROVIDERS = [
  'AuthTokenProvider',
  'CollectorRuntimeProvider',
  'AppsRuntimeProvider',
  'TransportProvider',
  'CollectorSenderForwarder',
  'AppsSenderForwarder',
  'GatekeeperClientProvider',
  'CollectorClientProvider',
  'FhirR4ResourcesClientProvider',
  'AppsClientProvider',
  'TunnelClientProvider',
] as const

describe('RootShell mount lifecycle', () => {
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

  // TanStack Router's scroll-restoration runs on every navigation and
  // calls `window.scrollTo`, which jsdom logs as "Not implemented:
  // window.scrollTo" through `console.error`. The behavior is
  // irrelevant to this regression guard, so suppress the noise to keep
  // the test output focused on real failures.
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
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

    // The outermost provider — `AuthTokenProvider` in `<RootShell>` —
    // is the canonical signal: if anything ABOVE the Outlet remounts
    // (or unmounts and never remounts), its event log diverges from a
    // single `['mount']`. Other providers might wobble in subtle
    // refactors, but the outer one is the regression-grade indicator.
    expect(lifecycleEventsFor('AuthTokenProvider')).toEqual(['mount'])

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
    expect(lifecycleEventsFor('AuthTokenProvider')).toEqual(['mount'])
  })

  test('no provider in the stack unmounts or remounts across navigation', async () => {
    // Broader assertion: every passthrough sees exactly `['mount']` —
    // no remounts (would mean the stack rebuilt under a new parent
    // route) and no unmounts (would mean the parent route stopped
    // matching). The all-providers sweep catches the subtle regression
    // mode where the stack splits and some providers migrate into a
    // sub-component that remounts.
    const router = buildTestRouter()

    render(<RouterProvider router={router} />)
    await waitFor(() => {
      expect(screen.getByTestId('leaf-a')).toBeDefined()
    })

    for (const name of ALL_PROVIDERS) {
      expect(lifecycleEventsFor(name)).toEqual(['mount'])
    }

    await act(async () => {
      await router.navigate({ to: '/b' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('leaf-b')).toBeDefined()
    })

    for (const name of ALL_PROVIDERS) {
      expect(lifecycleEventsFor(name)).toEqual(['mount'])
    }
  })
})
