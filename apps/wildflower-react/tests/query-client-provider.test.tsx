import { QueryClient, useQueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { QueryClientPersistProvider } from '../src/bridges/query-client-persist-provider.tsx'
import { buildQueryClient } from '../src/bridges/router-context.ts'

/**
 * Pins the wiring this PR introduced: the app builds ONE
 * {@link QueryClient} (`buildQueryClient`) and shares it two ways —
 *
 *  1. into the React tree via `<QueryClientPersistProvider>`, so every
 *     `useQuery` / `useMutation` in a slice resolves a client (without
 *     it, those hooks throw "No QueryClient set"); and
 *  2. into the TanStack Router `context`, so route `loader`s receive a
 *     typed `context.queryClient`.
 *
 * The two must be the SAME instance, or a `loader`'s `ensureQueryData`
 * would populate a different cache than the one the component reads.
 *
 * The four blocks below test, in order: the factory's documented
 * defaults, that it returns fresh instances, the shared-instance
 * contract (router context === the client the tree resolves), and the
 * end-to-end `renderApp` mount — the regression guard for the original
 * bug, where `QueryClientPersistProvider` was defined but mounted
 * nowhere, so `useQueryClient()` anywhere in the tree threw.
 */

describe('buildQueryClient', () => {
  // The defaults are the cache contract every screen + persister depends
  // on; pin them so a future edit to the factory can't silently change
  // staleness / GC / focus behavior out from under the persister.
  test('applies the stale-while-revalidate + 24h-GC query defaults', () => {
    // Arrange / Act
    const queryClient = buildQueryClient()
    const defaults = queryClient.getDefaultOptions().queries

    // Assert
    expect(defaults?.staleTime).toBe(0)
    expect(defaults?.gcTime).toBe(1000 * 60 * 60 * 24)
    expect(defaults?.refetchOnWindowFocus).toBe(false)
  })

  test('returns a fresh instance on each call', () => {
    // Arrange / Act
    const first = buildQueryClient()
    const second = buildQueryClient()

    // Assert
    expect(first).toBeInstanceOf(QueryClient)
    expect(first).not.toBe(second)
  })
})

describe('shared QueryClient wiring', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  // The contract downstream loader PRs depend on: the instance handed to
  // `createRouter`'s `context` is the very same one the React tree
  // resolves through `useQueryClient()`. We assert identity (`toBe`),
  // not equality — a structural match would still let the two caches
  // diverge. Uses the REAL `<QueryClientPersistProvider>` (its
  // localStorage persister restores cleanly under jsdom + a plain
  // `render`).
  test('the router context client is the same instance the React tree resolves', async () => {
    // Arrange
    const queryClient = buildQueryClient()
    let resolvedInTree: QueryClient | undefined
    const Leaf = (): JSX.Element => {
      resolvedInTree = useQueryClient()
      return <div data-testid="leaf" />
    }
    const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({})
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Leaf })
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
      context: { queryClient },
    })

    // Act
    render(
      <QueryClientPersistProvider queryClient={queryClient}>
        <RouterProvider router={router} />
      </QueryClientPersistProvider>
    )
    await waitFor(() => {
      expect(screen.getByTestId('leaf')).toBeDefined()
    })

    // Assert
    expect(router.options.context?.queryClient).toBe(queryClient)
    expect(resolvedInTree).toBe(queryClient)
  })
})

// `renderApp` pulls in the real provider stack and route tree; mock each
// slice provider / app bridge down to an identity passthrough (mirrors
// `root-shell.test.tsx`) so the test exercises only the QueryClient
// wiring, not the Effect runtimes or transport machinery the real stack
// boots. The mocked `routeTree.gen.ts` mounts a single leaf that reads
// the client via `useQueryClient()` — the hook that THREW before this
// PR, because no client context was mounted above the router.
// Identity wrapper standing in for every slice provider / app bridge —
// the concern under test is the QueryClient mount, not these providers.
// A `function` declaration (not a `const`) so JS hoists it fully: the
// `vi.mock` factories below are themselves hoisted to the top of the
// file, and a hoisted declaration is in scope for them (a `const` would
// be in its temporal dead zone).
function Passthrough({ children }: { readonly children?: ReactNode }): JSX.Element {
  return <>{children}</>
}

// `vi.hoisted` lifts these above the `vi.mock` factories too (Vitest
// hoists `vi.mock` to the top of the file, so referencing a non-hoisted
// `const` binding inside a factory is a temporal-dead-zone crash).
const { capturedQueryClients, LeafQueryClient } = vi.hoisted(() => {
  // Records every client a component resolved through `useQueryClient()`
  // inside the real `renderApp` tree, so the test can assert the leaf saw
  // the SAME instance `renderApp` threaded into the router context.
  const captured: QueryClient[] = []
  const Leaf = (): JSX.Element => {
    captured.push(useQueryClient())
    return <div data-testid="leaf-with-client">ok</div>
  }
  return { capturedQueryClients: captured, LeafQueryClient: Leaf }
})

vi.mock('react-kitchen-sink', () => ({ AuthTokenProvider: Passthrough }))
vi.mock('gatekeeper-react', () => ({
  authTokenRef: { get: () => null, subscribe: () => () => {} },
  GatekeeperClientProvider: Passthrough,
}))
vi.mock('collector-react', () => ({
  CollectorClientProvider: Passthrough,
  CollectorRuntimeProvider: Passthrough,
}))
vi.mock('fhir-r4-react', () => ({ FhirR4ResourcesClientProvider: Passthrough }))
vi.mock('apps-react', () => ({
  AppsClientProvider: Passthrough,
  AppsRuntimeProvider: Passthrough,
}))
vi.mock('tunnel-react', () => ({ TunnelClientProvider: Passthrough }))
vi.mock('../src/bridges/collector-sender-forwarder.tsx', () => ({
  CollectorSenderForwarder: Passthrough,
}))
vi.mock('../src/bridges/apps-sender-forwarder.tsx', () => ({
  AppsSenderForwarder: Passthrough,
}))
vi.mock('telemetry-web', () => ({
  ErrorBoundary: ({ children }: { readonly children?: ReactNode }): JSX.Element => <>{children}</>,
  Sentry: { captureException: () => {} },
}))
// Swap the generated tree for a minimal one: the real `__root` route
// (`RootShell`, mocked to passthroughs) plus one leaf that consumes the
// query client. `createRootRouteWithContext` here is the real builder
// (the router package is not mocked); `renderApp` supplies the concrete
// `{ queryClient }` context.
vi.mock('../src/routeTree.gen.ts', async () => {
  const { RootShell } = await import('../src/session/root-shell.tsx')
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: RootShell,
  })
  const leafRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: LeafQueryClient,
  })
  return { routeTree: rootRoute.addChildren([leafRoute]) }
})

// Poll the live DOM until `predicate` holds (or the attempt budget is
// spent). Used instead of testing-library's `waitFor`, because `waitFor`
// flushes through React's `act`, and the real `<QueryClientPersistProvider>`
// mounted by `renderApp` runs an async `persistQueryClientRestore` that —
// under `<StrictMode>`'s double-invoked effects — leaves a pending async
// state transition `act` waits on forever in jsdom. Polling the committed
// DOM from OUTSIDE `act` lets the production tree settle (it renders fine;
// only the harness's `act` flush stalls). Deterministic: a fixed attempt
// budget against a definite DOM condition, no randomness or wall-clock
// dependence.
const pollUntil = (predicate: () => boolean, attemptsLeft = 50): Promise<boolean> => {
  if (predicate()) {
    return Promise.resolve(true)
  }
  if (attemptsLeft <= 0) {
    return Promise.resolve(false)
  }
  return new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() =>
    pollUntil(predicate, attemptsLeft - 1)
  )
}

describe('renderApp QueryClient mount', () => {
  // `renderApp` mounts into `#root` via `createRoot`; create the
  // container before each render and tear it down after, so a second
  // render doesn't warn about reusing the node.
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    capturedQueryClients.length = 0
    const container = document.createElement('div')
    container.id = 'root'
    document.body.appendChild(container)
  })

  afterEach(() => {
    cleanup()
    document.getElementById('root')?.remove()
    vi.restoreAllMocks()
  })

  test('mounts a QueryClient context so useQueryClient resolves app-wide', async () => {
    // Arrange
    const { renderApp } = await import('../src/app-root.tsx')

    // Act — drive the REAL `renderApp` (StrictMode, createRoot, the real
    // `<QueryClientPersistProvider>` and router) end to end.
    renderApp({
      history: createMemoryHistory({ initialEntries: ['/'] }),
      TransportProvider: Passthrough,
      entry: 'main-web',
    })
    const leafMounted = await pollUntil(
      () => document.querySelector('[data-testid="leaf-with-client"]') !== null
    )

    // Assert — the leaf mounted, which means `useQueryClient()` inside it
    // did NOT throw; before this PR it would have (no client context was
    // mounted above the router), taking the tree down. Every client it
    // resolved is a real `QueryClient`, threaded down by `renderApp` —
    // the same instance also handed to the router context. (StrictMode
    // may render the leaf more than once; each capture must be valid.)
    expect(leafMounted).toBe(true)
    expect(capturedQueryClients.length).toBeGreaterThan(0)
    for (const client of capturedQueryClients) {
      expect(client).toBeInstanceOf(QueryClient)
    }
    // All captures resolve the one instance `renderApp` built and shared.
    const [first] = capturedQueryClients
    for (const client of capturedQueryClients) {
      expect(client).toBe(first)
    }
  })
})
