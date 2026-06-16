import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Effect, Layer, pipe, SubscriptionRef } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'
import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { TUNNEL_STATE_QUERY_KEY, type RunAuthed, type TunnelState } from './queries.ts'
import { sliceRuntimeLayer, type RouterContext } from './router-context.ts'
import { routeTree } from './routeTree.gen.ts'

// The fresh-install snapshot the cache (and the stub server's GET) starts at.
const INITIAL: TunnelState = {
  revision: 0,
  publicHost: null,
  requestedRunning: false,
  running: false,
  error: null,
  attempt: 0,
  servedOrigin: 'http://127.0.0.1:8080',
}

const jsonResponse = (status: number, body: TunnelState): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/**
 * Stateful stub server: GET returns the current snapshot; the FIRST PUT
 * 409s (simulating a concurrent writer that already advanced the server to
 * `revision 1` / `other.example.com`), and every later PUT applies and
 * bumps the revision. Keeping GET consistent with the adopted snapshot
 * means the mutation's `onSettled` refetch doesn't undo the 409 rebase.
 */
const makeConflictThenApplyHttp = (): Layer.Layer<HttpClient.HttpClient> => {
  let serverState: TunnelState = INITIAL
  let putCount = 0
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      if (request.method !== 'PUT') {
        return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(200, serverState)))
      }
      putCount += 1
      if (putCount === 1) {
        serverState = { ...INITIAL, revision: 1, publicHost: 'other.example.com' }
        return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(409, serverState)))
      }
      serverState = { ...serverState, revision: serverState.revision + 1 }
      return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(200, serverState)))
    })
  )
}

/** A server that only ever serves the initial snapshot (no writes expected). */
const makeReadOnlyHttp = (): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(200, INITIAL)))
    )
  )

// Mirrors the app's `buildRunAuthed`; kept local so the slice stays
// app-independent (same shape as queries.test.ts / routes.test.tsx).
const makeRunAuthed = (httpLayer: Layer.Layer<HttpClient.HttpClient>): RunAuthed => {
  const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('token'))
  return <A, E>(
    effect: Effect.Effect<A, E, BearerToken | HttpClient.HttpClient | TunnelAdminHttpApiClient>
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          pipe(
            sliceRuntimeLayer,
            Layer.provideMerge(httpLayer),
            Layer.provideMerge(Layer.succeed(BearerToken, tokenRef))
          )
        ),
        Effect.scoped
      )
    )
}

const renderTunnelRoute = (httpLayer: Layer.Layer<HttpClient.HttpClient>): QueryClient => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // Warm the cache so the route renders without suspending; the stub GET
  // still backs the `onSettled` refetch.
  queryClient.setQueryData<TunnelState>(TUNNEL_STATE_QUERY_KEY, INITIAL)
  const context: RouterContext = {
    queryClient,
    runAuthed: makeRunAuthed(httpLayer),
    runtimeLayer: Layer.die('runtimeLayer not used in this test'),
    awaitAuthReady: () => Promise.resolve(),
  }
  const router = createRouter({
    routeTree,
    context,
    history: createMemoryHistory({ initialEntries: ['/settings/tunnel'] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return queryClient
}

const asInput = (el: HTMLElement): HTMLInputElement => {
  if (!(el instanceof HTMLInputElement)) throw new Error('expected an <input> element')
  return el
}

afterEach(() => {
  cleanup()
})

describe('tunnel settings form — conflict flow', () => {
  test('on a 409 the host input re-syncs to the adopted snapshot and the banner shows', async () => {
    renderTunnelRoute(makeConflictThenApplyHttp())

    const host = asInput(await screen.findByLabelText('Public host'))
    fireEvent.change(host, { target: { value: 'mine.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // The adopted 409 snapshot replaces the stale edit — the input now
    // truthfully shows the other writer's value, so a blind re-Save can't
    // clobber it.
    await waitFor(() => {
      expect(asInput(screen.getByLabelText('Public host')).value).toBe('other.example.com')
    })
    expect(screen.getByText(/changed elsewhere/i)).toBeDefined()
  })

  test('the conflict banner persists across an unrelated toggle', async () => {
    const queryClient = renderTunnelRoute(makeConflictThenApplyHttp())

    const host = asInput(await screen.findByLabelText('Public host'))
    fireEvent.change(host, { target: { value: 'mine.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/changed elsewhere/i)

    // Toggling applies cleanly (fresh revision) but must NOT clear the
    // unresolved host conflict.
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => {
      expect(queryClient.getQueryData<TunnelState>(TUNNEL_STATE_QUERY_KEY)?.revision).toBe(2)
    })
    expect(screen.queryByText(/changed elsewhere/i)).not.toBeNull()
  })

  test('editing the host dismisses the conflict banner', async () => {
    renderTunnelRoute(makeConflictThenApplyHttp())

    const host = asInput(await screen.findByLabelText('Public host'))
    fireEvent.change(host, { target: { value: 'mine.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/changed elsewhere/i)

    fireEvent.change(screen.getByLabelText('Public host'), {
      target: { value: 'mine-again.example.com' },
    })
    expect(screen.queryByText(/changed elsewhere/i)).toBeNull()
  })
})

describe('tunnel settings form — relay validation', () => {
  test('a partial relay draft surfaces an error outside the collapsed section and disables Save', async () => {
    renderTunnelRoute(makeReadOnlyHttp())

    await screen.findByLabelText('Public host')
    // Fill only one of the four relay fields.
    fireEvent.change(screen.getByLabelText('Relay address'), {
      target: { value: 'relay.example.com:2333' },
    })

    expect(screen.getByText(/Fill all four relay fields/i)).toBeDefined()
    const save = screen.getByRole('button', { name: 'Save' })
    if (!(save instanceof HTMLButtonElement)) throw new Error('expected a <button>')
    expect(save.disabled).toBe(true)
  })
})
