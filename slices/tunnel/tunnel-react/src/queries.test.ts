import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { Arbitrary, Effect, Layer, pipe } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { createElement } from 'react'
import { Tunnel } from 'tunnel-core/http-api-definition'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import {
  applyTunnelOptimistic,
  buildReplacePayload,
  isTunnelState,
  TUNNEL_STATE_QUERY_KEY,
  tunnelStateQueryOptions,
  useTunnelReplaceMutation,
  type RunAuthed,
  type TunnelReplaceInput,
  type TunnelReplaceResult,
  type TunnelState,
} from './queries.ts'
import { sliceRuntimeLayer, type RouterContext } from './router-context.ts'

/**
 * Drives `tunnelStateQueryOptions(runAuthed)` over the real
 * runner→tunnel-layer→HttpClient path, with a stub HttpClient that
 * returns a canned `TunnelState` body.
 */

const TUNNEL_STATE_BODY = Tunnel.freshTunnelState

// `failing: true` always 500s — drives the rejecting read path that the
// route loader now propagates (see routes.test.tsx) instead of swallowing.
const stubHttpClientLayer = (options?: {
  readonly failing?: boolean
}): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          options?.failing === true
            ? new Response(null, { status: 500 })
            : new Response(JSON.stringify(TUNNEL_STATE_BODY), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
        )
      )
    )
  )

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  cleanup()
  await Promise.all(disposers.splice(0).map((dispose) => dispose()))
})

// Mirrors `buildRunAuthed`; kept local so the slice has no app dep.
const makeRunAuthed = (httpLayer: Layer.Layer<HttpClient.HttpClient>): RunAuthed => {
  return <A, E>(
    effect: Effect.Effect<A, E, HttpClient.HttpClient | TunnelAdminHttpApiClient>
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(pipe(sliceRuntimeLayer, Layer.provideMerge(httpLayer))),
        Effect.scoped
      )
    )
}

const BASE_STATE: TunnelState = {
  settingsRevision: 5,
  publicHost: 'old.example.com',
  requestedRunning: false,
  status: 'off',
  running: false,
  error: null,
  dialAttempts: 0,
  servedOrigin: 'http://127.0.0.1:8080',
  relay: null,
}

const RELAY = {
  remoteAddr: 'relay.example.com:2333',
  token: 'secret',
  publicKey: 'base64key',
  serviceName: 'wildflower',
}

describe('tunnelStateQueryOptions', () => {
  test('exposes the canonical TUNNEL_STATE_QUERY_KEY', () => {
    const options = tunnelStateQueryOptions(makeRunAuthed(stubHttpClientLayer()))
    expect(options.queryKey).toEqual(TUNNEL_STATE_QUERY_KEY)
  })

  test('queryFn reads TunnelState through the authed runner', async () => {
    const options = tunnelStateQueryOptions(makeRunAuthed(stubHttpClientLayer()))
    const queryClient = new QueryClient()
    disposers.push(() => Promise.resolve(queryClient.clear()))

    const state = await queryClient.query({ ...options, staleTime: 'static' })

    expect(state.settingsRevision).toBe(0)
    expect(state.servedOrigin).toBe('http://127.0.0.1:8080')
    expect(state.running).toBe(false)
    expect(queryClient.getQueryData(TUNNEL_STATE_QUERY_KEY)).toEqual(state)
  })

  test('a failed read rejects ensureQueryData (the route loader propagates this)', async () => {
    const options = tunnelStateQueryOptions(makeRunAuthed(stubHttpClientLayer({ failing: true })))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    disposers.push(() => Promise.resolve(queryClient.clear()))

    // Pins the rejection the route loader surfaces to its errorComponent
    // (no longer swallowed) — see routes.test.tsx for the loader path.
    await expect(queryClient.query({ ...options, staleTime: 'static' })).rejects.toThrow()
    expect(queryClient.getQueryData(TUNNEL_STATE_QUERY_KEY)).toBeUndefined()
  })
})

describe('buildReplacePayload', () => {
  test('always carries the revision from the cached snapshot', () => {
    const payload = buildReplacePayload(BASE_STATE, { requestedRunning: true })
    expect(payload.settingsRevision).toBe(5)
  })

  test('omitted visible fields are filled from the cached snapshot', () => {
    // Toggling requestedRunning keeps the stored publicHost — the same-client
    // stale-cache race the contract guards against.
    const payload = buildReplacePayload(BASE_STATE, { requestedRunning: true })
    expect(payload).toEqual({
      settingsRevision: 5,
      publicHost: 'old.example.com',
      requestedRunning: true,
    })
  })

  test('provided fields override the snapshot; null clears the host', () => {
    expect(buildReplacePayload(BASE_STATE, { publicHost: 'new.example.com' }).publicHost).toBe(
      'new.example.com'
    )
    expect(buildReplacePayload(BASE_STATE, { publicHost: null }).publicHost).toBeNull()
  })

  test('relay is included only when supplied', () => {
    const without = buildReplacePayload(BASE_STATE, { publicHost: 'x' })
    expect('relay' in without).toBe(false)

    const withRelay = buildReplacePayload(BASE_STATE, { relay: RELAY })
    expect(withRelay.relay).toEqual(RELAY)
  })

  test('revision always tracks the snapshot and omitted fields are preserved', () => {
    fc.assert(
      fc.property(
        Arbitrary.make(Tunnel.TunnelStateViewSchema),
        fc.option(fc.option(fc.string(), { nil: null }), { nil: undefined }),
        fc.option(fc.boolean(), { nil: undefined }),
        (current, publicHost, requestedRunning) => {
          const payload = buildReplacePayload(current, { publicHost, requestedRunning })
          expect(payload.settingsRevision).toBe(current.settingsRevision)
          expect(payload.publicHost).toBe(
            publicHost === undefined ? current.publicHost : publicHost
          )
          expect(payload.requestedRunning).toBe(
            requestedRunning === undefined ? current.requestedRunning : requestedRunning
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('applyTunnelOptimistic', () => {
  test('projects the visible fields onto the snapshot', () => {
    const next = applyTunnelOptimistic(BASE_STATE, {
      publicHost: 'new.example.com',
      requestedRunning: true,
    })
    expect(next.publicHost).toBe('new.example.com')
    expect(next.requestedRunning).toBe(true)
  })

  test('an omitted field preserves the previous value', () => {
    const next = applyTunnelOptimistic(BASE_STATE, { requestedRunning: true })
    expect(next.publicHost).toBe('old.example.com')
    expect(next.requestedRunning).toBe(true)
  })

  test('never touches server-derived fields or the revision', () => {
    const live: TunnelState = {
      ...BASE_STATE,
      settingsRevision: 9,
      status: 'verified',
      running: true,
      error: 'boom',
      dialAttempts: 3,
      servedOrigin: 'https://live.example.com',
    }
    const next = applyTunnelOptimistic(live, { publicHost: 'x', requestedRunning: true })
    expect(next.settingsRevision).toBe(9)
    expect(next.running).toBe(true)
    expect(next.error).toBe('boom')
    expect(next.dialAttempts).toBe(3)
    expect(next.servedOrigin).toBe('https://live.example.com')
  })

  test('client-writable fields follow omitted-preserves / present-writes', () => {
    const optionalHost = fc.option(fc.option(fc.string(), { nil: null }), { nil: undefined })
    fc.assert(
      fc.property(
        Arbitrary.make(Tunnel.TunnelStateViewSchema),
        optionalHost,
        fc.option(fc.boolean(), { nil: undefined }),
        (previous, publicHost, requestedRunning) => {
          const next = applyTunnelOptimistic(previous, { publicHost, requestedRunning })
          expect(next.publicHost).toBe(publicHost === undefined ? previous.publicHost : publicHost)
          expect(next.requestedRunning).toBe(
            requestedRunning === undefined ? previous.requestedRunning : requestedRunning
          )
          // server-owned fields untouched
          expect(next.settingsRevision).toBe(previous.settingsRevision)
          expect(next.running).toBe(previous.running)
          expect(next.servedOrigin).toBe(previous.servedOrigin)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('isTunnelState', () => {
  test('accepts a decoded state snapshot (the 409 body)', () => {
    expect(isTunnelState(BASE_STATE)).toBe(true)
  })

  test('any schema-conformant state is recognised as a conflict body', () => {
    fc.assert(
      fc.property(Arbitrary.make(Tunnel.TunnelStateViewSchema), (state) => {
        expect(isTunnelState(state)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('rejects genuine transport/decode errors', () => {
    expect(isTunnelState(new Error('network down'))).toBe(false)
    // HttpClientError-shaped value from the client error channel.
    expect(isTunnelState({ _tag: 'ResponseError', request: {}, response: {} })).toBe(false)
    // Structurally close but wrong-typed revision.
    expect(isTunnelState({ ...BASE_STATE, settingsRevision: 'nope' })).toBe(false)
    expect(isTunnelState(null)).toBe(false)
  })
})

const jsonResponse = (status: number, body: TunnelState): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// GET serves `served`; every PUT 409s with `conflict` (a *different* snapshot),
// so the only way the cache can come to hold `conflict` is the mutation's
// onSuccess adopting `result.current` — a refetch would deliver `served`.
const makePutConflictHttp = (
  served: TunnelState,
  conflict: TunnelState
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.method === 'PUT' ? jsonResponse(409, conflict) : jsonResponse(200, served)
        )
      )
    )
  )

/**
 * Mount ONLY the replace mutation — no {@link useTunnelStateQuery} observer — so
 * the mutation's `onSettled` invalidate has no active query to refetch. That
 * leaves nothing to mask whether `onSuccess` adopted the server snapshot into
 * the cache.
 */
const mountReplaceMutation = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  seed: TunnelState
): {
  readonly queryClient: QueryClient
  readonly mutate: { current?: (input: TunnelReplaceInput) => Promise<TunnelReplaceResult> }
} => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData<TunnelState>(TUNNEL_STATE_QUERY_KEY, seed)
  disposers.push(() => Promise.resolve(queryClient.clear()))

  const mutate: { current?: (input: TunnelReplaceInput) => Promise<TunnelReplaceResult> } = {}
  const Harness = (): null => {
    mutate.current = useTunnelReplaceMutation().mutateAsync
    return null
  }
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Harness })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
    context: {
      queryClient,
      runAuthed: makeRunAuthed(httpLayer),
      runtimeLayer: Layer.die('runtimeLayer not used in this test'),
      awaitAuthReady: () => Promise.resolve(),
    } satisfies RouterContext,
  })
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RouterProvider, { router })
    )
  )
  return { queryClient, mutate }
}

describe('useTunnelReplaceMutation cache adoption', () => {
  test('a 409 adopts result.current into the cache (not masked by the refetch)', async () => {
    const served = BASE_STATE
    const conflict: TunnelState = {
      ...BASE_STATE,
      settingsRevision: 6,
      publicHost: 'other.example.com',
    }
    const { queryClient, mutate } = mountReplaceMutation(
      makePutConflictHttp(served, conflict),
      served
    )

    await waitFor(() => {
      expect(mutate.current).toBeDefined()
    })

    let result: TunnelReplaceResult | undefined
    await act(async () => {
      result = await mutate.current?.({ requestedRunning: true })
    })

    // The PUT 409'd → Conflict result carrying the server's current snapshot...
    expect(result).toEqual({ _tag: 'Conflict', current: conflict })
    // ...and onSuccess adopted it. With no active observer, onSettled's
    // invalidate can't refetch `served` over it, so the cache proves the
    // adoption ran: drop the onSuccess setQueryData and this reads `served`.
    expect(queryClient.getQueryData<TunnelState>(TUNNEL_STATE_QUERY_KEY)).toEqual(conflict)
  })
})
