import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute } from '@tanstack/react-router'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { Effect, Layer } from 'effect'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

/**
 * Pins that `renderApp` provides ONE shared in-memory `QueryClient` to
 * the whole tree — no persister.
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

// Null-token ref short-circuits the eager startup prefetch.
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
  AppsRuntimeProvider: Passthrough,
  AppsRouterContext: { sliceRuntimeLayer: Layer.empty },
}))
// Prefetch is gated off; these stubs just satisfy the imports.
vi.mock('tunnel-react', () => ({
  tunnelStateQueryOptions: () => ({ queryKey: ['tunnel', 'state'], queryFn: () => null }),
  TunnelRouterContext: { sliceRuntimeLayer: Layer.empty },
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
// Bare `HttpClient` so the authed runtime constructs offline.
vi.mock('telemetry-react', () => ({
  webHttpClientLayer: Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
    )
  ),
}))
// Minimal route tree; leaf records the `QueryClient` it sees.
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

    // StrictMode may double-invoke; every capture must be the same instance.
    expect(capturedQueryClients.length).toBeGreaterThan(0)
    const first = capturedQueryClients[0]
    expect(first).toBeInstanceOf(QueryClient)
    for (const client of capturedQueryClients) {
      expect(client).toBe(first)
    }
  })
})
