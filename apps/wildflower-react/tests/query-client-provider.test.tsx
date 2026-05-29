import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute } from '@tanstack/react-router'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { Effect, Layer } from 'effect'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

/**
 * Pins the IN-MEMORY query-client wiring this branch introduces — the
 * deliberate alternative to PR #99's localStorage-backed
 * `PersistQueryClientProvider`.
 *
 * `renderApp` now:
 *   - builds ONE `QueryClient` via `buildQueryClient()`,
 *   - hands it to a plain `<QueryClientProvider>` (from
 *     `@tanstack/react-query`) wrapping the whole tree, so every
 *     descendant `useQueryClient()` resolves THAT client (no persister,
 *     nothing read from / written to `localStorage`), AND
 *   - passes the same instance into `createRouter`'s typed `context`.
 *
 * This test mounts the real `renderApp` with a minimal route tree whose
 * leaf records the `QueryClient` it sees via `useQueryClient()`, and
 * asserts a single shared client is provided. Rendered WITHOUT a persist
 * provider, so the `PersistQueryClientProvider × StrictMode` jsdom
 * deadlock (#99/#102) cannot occur — a plain in-memory provider is safe
 * under `<StrictMode>`.
 */

const { capturedQueryClients, LeafQueryClient } = vi.hoisted(() => {
  const captured: QueryClient[] = []
  const Leaf = (): JSX.Element => {
    captured.push(useQueryClient())
    return <div data-testid="leaf">leaf</div>
  }
  return { capturedQueryClients: captured, LeafQueryClient: Leaf }
})

const { Passthrough } = vi.hoisted(() => ({
  Passthrough: ({ children }: { readonly children?: ReactNode }): JSX.Element => <>{children}</>,
}))

// `renderApp` reads the token via `Effect.runSync(authTokenRef.get)` to
// gate the eager startup prefetch; a null-token ref short-circuits it.
vi.mock('gatekeeper-react', () => ({
  authTokenRef: { get: Effect.succeed(null), changes: { pipe: () => ({}) } },
  GatekeeperClientProvider: Passthrough,
}))
vi.mock('react-kitchen-sink', () => ({ AuthTokenProvider: Passthrough }))
vi.mock('collector-react', () => ({
  CollectorClientProvider: Passthrough,
  CollectorRuntimeProvider: Passthrough,
}))
vi.mock('fhir-r4-react', () => ({ FhirR4ResourcesClientProvider: Passthrough }))
vi.mock('apps-react', () => ({
  AppsClientProvider: Passthrough,
  AppsRuntimeProvider: Passthrough,
}))
// Eager prefetch is gated off (null token), so `tunnelStateQueryOptions`
// is never invoked; stub it so the import resolves.
vi.mock('tunnel-react', () => ({
  tunnelStateQueryOptions: () => ({ queryKey: ['tunnel', 'state'], queryFn: () => null }),
}))
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
// `renderApp` builds `runAuthed` from `webHttpClientLayer`; stub it to a
// bare `HttpClient` so the authed runtime constructs offline.
vi.mock('telemetry-react', () => ({
  webHttpClientLayer: Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
    )
  ),
}))
// Swap the generated route tree for a minimal one: the real
// `RootShell` is a passthrough chain (mocked above), and the leaf
// records the `QueryClient` it sees. The router still mounts through the
// real `renderApp` + `<QueryClientProvider>`, which is the thing pinned.
vi.mock('../src/routeTree.gen.ts', () => {
  const rootRoute = createRootRoute({ component: RootShell })
  const leaf = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: LeafQueryClient,
  })
  return { routeTree: rootRoute.addChildren([leaf]) }
})

import { RootShell } from '../src/session/root-shell.tsx'

const silenceScrollTo = (): void => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
}

describe('in-memory QueryClientProvider', () => {
  beforeEach(() => {
    silenceScrollTo()
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

  test('provides a single shared QueryClient to the whole tree', async () => {
    const { renderApp } = await import('../src/app-root.tsx')

    await act(async () => {
      renderApp({
        history: createMemoryHistory({ initialEntries: ['/'] }),
        TransportProvider: Passthrough,
        entry: 'main-web',
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('leaf')).toBeDefined()
    })

    // At least one capture (StrictMode may double-invoke), and EVERY
    // captured client is the same instance — proving one shared
    // in-memory client is provided app-wide.
    expect(capturedQueryClients.length).toBeGreaterThan(0)
    const first = capturedQueryClients[0]
    expect(first).toBeInstanceOf(QueryClient)
    for (const client of capturedQueryClients) {
      expect(client).toBe(first)
    }
  })
})
