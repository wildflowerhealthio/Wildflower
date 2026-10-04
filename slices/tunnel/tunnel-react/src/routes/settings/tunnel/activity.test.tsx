import { HttpClient, HttpClientResponse, UrlParams } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Effect, Layer, pipe } from 'effect'
import { GatekeeperRouterContext } from 'gatekeeper-react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import type { RunAuthed } from '../../../queries/index.ts'
import { sliceRuntimeLayer } from '../../../router-context.ts'
import { routeTree } from '../../../routeTree.gen.ts'

/**
 * Drives `/settings/tunnel/activity` through a real router and the real query
 * → client → `HttpClient` path, against a stub server holding a three-request
 * log in two pages, the caller summary, and gatekeeper's client list.
 */

const loggedRequest = (
  id: number,
  overrides: Partial<Record<string, unknown>>
): Record<string, unknown> => ({
  id,
  receivedAt: `2026-07-01T12:0${id}:00Z`,
  clientId: 'lifting',
  address: '198.51.100.24',
  servedHost: 'dev1.example.com',
  method: 'GET',
  path: '/fhir-r4/Patient',
  status: 200,
  responseBytes: 2048,
  durationMs: 12,
  refusal: null,
  ...overrides,
})

const FIRST_PAGE = {
  requests: [
    loggedRequest(4, {
      clientId: null,
      address: '203.0.113.9',
      status: 401,
      refusal: 'tokenRejected',
    }),
    loggedRequest(3, { clientId: 'unnamed-client', path: '/access' }),
  ],
  nextCursor: 3,
}

const LAST_PAGE = {
  requests: [
    loggedRequest(2, { method: 'POST', path: '/fhir-r4/Observation' }),
    loggedRequest(1, { clientId: null, path: '/.well-known' }),
  ],
  nextCursor: null,
}

const CALLERS = [
  {
    clientId: 'lifting',
    address: '198.51.100.24',
    firstSeen: '2026-07-01T11:00:00Z',
    lastSeen: '2026-07-01T12:01:00Z',
    requestCount: 2,
    refusedCount: 1,
    lastStatus: 200,
    lastRefusal: null,
  },
  {
    clientId: 'lifting',
    address: '192.0.2.1',
    firstSeen: '2026-07-01T10:00:00Z',
    lastSeen: '2026-07-01T10:30:00Z',
    requestCount: 1,
    refusedCount: 0,
    lastStatus: 200,
    lastRefusal: null,
  },
]

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

/** Every `ListRequests` query string the stub server saw, in order. */
let requestQueries: string[] = []

const stubServerLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    const path = new URL(request.url, 'http://device.test').pathname
    if (path.endsWith('/tunnel/requests/callers')) {
      return Effect.succeed(HttpClientResponse.fromWeb(request, json(CALLERS)))
    }
    if (path.endsWith('/tunnel/requests')) {
      const query = UrlParams.toString(request.urlParams)
      requestQueries.push(query)
      const page = new URLSearchParams(query).get('cursor') === '3' ? LAST_PAGE : FIRST_PAGE
      return Effect.succeed(HttpClientResponse.fromWeb(request, json(page)))
    }
    if (path.endsWith('/clients')) {
      return Effect.succeed(HttpClientResponse.fromWeb(request, json(CLIENTS)))
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })))
  })
)

// The app's composed runner serves every slice's client; this one serves the
// two the screen reads through — tunnel's log and gatekeeper's client names.
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

const renderActivity = (search = ''): void => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createRouter({
    routeTree,
    context: {
      queryClient,
      runAuthed,
      runtimeLayer: Layer.die('runtimeLayer not used by the activity page'),
      awaitAuthReady: () => Promise.resolve(),
    },
    history: createMemoryHistory({ initialEntries: [`/settings/tunnel/activity${search}`] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

const rowOf = async (text: string): Promise<HTMLElement> => {
  const row = (await screen.findByText(text)).closest('tr')
  if (row === null) throw new Error(`no table row holds ${text}`)
  return row
}

beforeEach(() => {
  requestQueries = []
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(navigator, 'clipboard')
  vi.restoreAllMocks()
})

describe('/settings/tunnel/activity', () => {
  test('pages through the log behind "Load more"', async () => {
    renderActivity()

    expect(await rowOf('GET /access')).toBeTruthy()
    expect(screen.queryByText('POST /fhir-r4/Observation')).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))

    expect(await rowOf('POST /fhir-r4/Observation')).toBeTruthy()
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    })
    expect(requestQueries).toEqual(['', 'cursor=3'])
  })

  test('names each caller and labels each access case', async () => {
    renderActivity()

    const refused = await rowOf('No client')
    expect(within(refused).getByText('Refused · token rejected')).toBeTruthy()
    expect(refused.className).toMatch(/activity__row--refused/)
    expect(within(await rowOf('unnamed-client')).getByText('GET /access')).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    const signedIn = await rowOf('POST /fhir-r4/Observation')
    expect(within(signedIn).getByText('Lifting app')).toBeTruthy()
    expect(within(signedIn).getByText('Signed in')).toBeTruthy()
    expect(within(await rowOf('GET /.well-known')).getByText('No sign-in needed')).toBeTruthy()
  })

  test('filters by client, with the client summary, and narrows by access', async () => {
    renderActivity('?client=lifting')

    const summary = await screen.findByRole('region', { name: 'Client summary' })
    expect(await within(summary).findByText('Lifting app')).toBeTruthy()
    expect(
      await within(summary).findByText(/^3 requests · 1 refused · 2 addresses · first seen/)
    ).toBeTruthy()
    await waitFor(() => {
      expect(requestQueries).toEqual(['client=lifting'])
    })

    fireEvent.change(screen.getByLabelText('Access'), { target: { value: 'refused' } })

    await waitFor(() => {
      expect(requestQueries).toEqual(['client=lifting', 'client=lifting&auth=refused'])
    })
  })

  test('filters by address, with Copy address and a disabled Block this address', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderActivity('?address=203.0.113.9')

    const panel = await screen.findByRole('region', { name: 'Address' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Copy address' }))

    expect(writeText).toHaveBeenCalledWith('203.0.113.9')
    expect(within(panel).getByRole('button', { name: 'Block this address' })).toHaveProperty(
      'disabled',
      true
    )
    await waitFor(() => {
      expect(requestQueries).toEqual(['address=203.0.113.9'])
    })
  })

  test('exports every page of the filtered log as CSV', async () => {
    const saved: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      if (blob instanceof Blob) saved.push(blob)
      return 'blob:activity'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    renderActivity('?auth=refused')
    await rowOf('GET /access')

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    // The table's own first page, then the export's read of the whole filter.
    expect(requestQueries).toEqual(['auth=refused', 'auth=refused', 'cursor=3&auth=refused'])
    const lines = (await saved[0]?.text())?.trimEnd().split('\r\n')
    expect(lines?.[0]).toBe(
      'received_at,client_id,client_name,access,address,served_host,method,path,status,refusal,response_bytes,duration_ms'
    )
    expect(lines?.slice(1)).toEqual([
      '2026-07-01T12:04:00.000Z,,No client,refused,203.0.113.9,dev1.example.com,GET,/fhir-r4/Patient,401,tokenRejected,2048,12',
      '2026-07-01T12:03:00.000Z,unnamed-client,unnamed-client,authorized,198.51.100.24,dev1.example.com,GET,/access,200,,2048,12',
      '2026-07-01T12:02:00.000Z,lifting,Lifting app,authorized,198.51.100.24,dev1.example.com,POST,/fhir-r4/Observation,200,,2048,12',
      '2026-07-01T12:01:00.000Z,,Open,public,198.51.100.24,dev1.example.com,GET,/.well-known,200,,2048,12',
    ])
  })
})
