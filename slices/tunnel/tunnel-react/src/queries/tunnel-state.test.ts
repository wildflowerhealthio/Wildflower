import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { Effect, Layer, pipe } from 'effect'
import { Tunnel } from 'tunnel-core/http-api-definition'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { sliceRuntimeLayer } from '../router-context.ts'
import { TUNNEL_STATE_QUERY_KEY, tunnelStateQueryOptions, type RunAuthed } from './index.ts'

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

    expect(state).toEqual(Tunnel.freshTunnelState)
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
