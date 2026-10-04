import { HttpClient, HttpClientResponse, UrlParams } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, within } from '@testing-library/react'
import { Effect, Layer, pipe } from 'effect'
import { GatekeeperRouterContext } from 'gatekeeper-react'
import { Tunnel } from 'tunnel-core/http-api-definition'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import type { RunAuthed } from '../../../queries/index.ts'
import { sliceRuntimeLayer } from '../../../router-context.ts'
import { routeTree } from '../../../routeTree.gen.ts'

/**
 * Drives the overview's activity card through a real router and the real query
 * → client → `HttpClient` path: a running tunnel, three callers in the log, a
 * burst of refused requests from one address, and gatekeeper's client list.
 */

const RUNNING_STATE = { ...Tunnel.freshTunnelState, requestedRunning: true, running: true }

const CALLERS = [
  {
    clientId: 'lifting',
    address: '192.0.2.1',
    firstSeen: '2026-07-01T10:00:00Z',
    lastSeen: '2026-07-01T12:00:00Z',
    requestCount: 30,
    refusedCount: 0,
    lastStatus: 200,
    lastRefusal: null,
  },
  {
    clientId: 'unnamed-client',
    address: '198.51.100.24',
    firstSeen: '2026-07-01T10:00:00Z',
    lastSeen: '2026-07-01T11:00:00Z',
    requestCount: 5,
    refusedCount: 1,
    lastStatus: 403,
    lastRefusal: null,
  },
  {
    clientId: null,
    address: '203.0.113.9',
    firstSeen: '2026-07-01T09:00:00Z',
    lastSeen: '2026-07-01T10:00:00Z',
    requestCount: 12,
    refusedCount: 12,
    lastStatus: 401,
    lastRefusal: 'tokenRejected',
  },
]

const refusedNow = (id: number): Record<string, unknown> => ({
  id,
  receivedAt: new Date().toISOString(),
  clientId: null,
  address: '203.0.113.9',
  servedHost: 'dev1.example.com',
  method: 'GET',
  path: '/fhir-r4/Patient',
  status: 401,
  responseBytes: null,
  durationMs: 3,
  refusal: 'tokenRejected',
})

const CLIENTS = [
  {
    clientId: 'lifting',
    name: 'Lifting app',
    kind: 'public',
    redirectUris: [],
    allowedScopes: [],
    allowedGrantTypes: [],
    registeredAt: '2026-06-01T00:00:00Z',
    disabledAt: null,
    firstParty: false,
  },
]

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const stubServerLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    const path = new URL(request.url, 'http://device.test').pathname
    const respond = (response: Response): Effect.Effect<HttpClientResponse.HttpClientResponse> =>
      Effect.succeed(HttpClientResponse.fromWeb(request, response))
    if (path.endsWith('/tunnel')) return respond(json(RUNNING_STATE))
    if (path.endsWith('/tunnel/requests/callers')) return respond(json(CALLERS))
    if (path.endsWith('/tunnel/requests')) {
      // The card reads only refused requests, for the streak warning.
      expect(UrlParams.toString(request.urlParams)).toBe('auth=refused')
      const requests = Array.from({ length: 12 }, (_, index) => refusedNow(12 - index))
      return respond(json({ requests, nextCursor: null }))
    }
    if (path.endsWith('/clients')) return respond(json(CLIENTS))
    return respond(new Response(null, { status: 404 }))
  })
)

const runAuthed: RunAuthed = (effect) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        pipe(
          Layer.merge(sliceRuntimeLayer, GatekeeperRouterContext.sliceRuntimeLayer),
          Layer.provideMerge(stubServerLayer)
        )
      ),
      Effect.scoped
    )
  )

const renderOverview = (): void => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createRouter({
    routeTree,
    context: {
      queryClient,
      runAuthed,
      runtimeLayer: Layer.die('runtimeLayer not used by the overview'),
      awaitAuthReady: () => Promise.resolve(),
    },
    history: createMemoryHistory({ initialEntries: ['/settings/tunnel'] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
})

describe('/settings/tunnel activity card', () => {
  test('lists the callers from the request log, named by gatekeeper or their id', async () => {
    renderOverview()

    expect(await screen.findByText('Lifting app')).toBeTruthy()
    expect(await screen.findByText('192.0.2.1 · Signed in')).toBeTruthy()
    expect(await screen.findByText('unnamed-client')).toBeTruthy()
    expect(await screen.findByText('No client')).toBeTruthy()
    expect(
      await screen.findByText('47 requests · 34 signed in · 0 no sign-in needed · 13 refused')
    ).toBeTruthy()
  })

  test('shows refused callers as refused rows with the reason', async () => {
    renderOverview()

    const scoped = (await screen.findByText('198.51.100.24 · Refused · forbidden')).closest('li')
    expect(scoped?.className).toMatch(/tone-danger/)
    expect(await screen.findByText('203.0.113.9 · Refused · token rejected')).toBeTruthy()
  })

  test('warns about a refused streak and links to that address’s refused requests', async () => {
    renderOverview()

    const warning = await screen.findByRole('alert')
    expect(warning.textContent).toMatch(
      /^12 refused requests from 203\.0\.113\.9 in the last 10 minutes — possible credential guessing\./
    )
    expect(within(warning).getByRole('link', { name: 'Review' }).getAttribute('href')).toBe(
      '/settings/tunnel/activity?address=203.0.113.9&auth=refused'
    )
  })
})
