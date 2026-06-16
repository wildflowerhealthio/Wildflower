import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { Arbitrary, Effect, Layer, pipe, SubscriptionRef } from 'effect'
import * as fc from 'fast-check'
import { BearerToken } from 'kitchen-sink/auth-token'
import { numRunsFor } from 'kitchen-sink/test'
import { Tunnel } from 'tunnel-core/http-api-definition'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import {
  applyTunnelOptimistic,
  buildReplacePayload,
  isTunnelState,
  TUNNEL_STATE_QUERY_KEY,
  tunnelStateQueryOptions,
  type RunAuthed,
  type TunnelState,
} from './queries.ts'
import { sliceRuntimeLayer } from './router-context.ts'

/**
 * Drives `tunnelStateQueryOptions(runAuthed)` over the real
 * runner→tunnel-layer→HttpClient path, with a stub HttpClient that
 * returns a canned `TunnelState` body.
 */

const TUNNEL_STATE_BODY = {
  revision: 0,
  publicHost: null,
  requestedRunning: false,
  running: false,
  error: null,
  attempt: 0,
  servedOrigin: 'http://127.0.0.1:8080',
  relay: null,
}

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

const BASE_STATE: TunnelState = {
  revision: 5,
  publicHost: 'old.example.com',
  requestedRunning: false,
  running: false,
  error: null,
  attempt: 0,
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

    const state = await queryClient.ensureQueryData(options)

    expect(state.revision).toBe(0)
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
    await expect(queryClient.ensureQueryData(options)).rejects.toThrow()
    expect(queryClient.getQueryData(TUNNEL_STATE_QUERY_KEY)).toBeUndefined()
  })
})

describe('buildReplacePayload', () => {
  test('always carries the revision from the cached snapshot', () => {
    const payload = buildReplacePayload(BASE_STATE, { requestedRunning: true })
    expect(payload.revision).toBe(5)
  })

  test('omitted visible fields are filled from the cached snapshot', () => {
    // Toggling requestedRunning keeps the stored publicHost — the same-client
    // stale-cache race the contract guards against.
    const payload = buildReplacePayload(BASE_STATE, { requestedRunning: true })
    expect(payload).toEqual({
      revision: 5,
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
          expect(payload.revision).toBe(current.revision)
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
      revision: 9,
      running: true,
      error: 'boom',
      attempt: 3,
      servedOrigin: 'https://live.example.com',
    }
    const next = applyTunnelOptimistic(live, { publicHost: 'x', requestedRunning: true })
    expect(next.revision).toBe(9)
    expect(next.running).toBe(true)
    expect(next.error).toBe('boom')
    expect(next.attempt).toBe(3)
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
          expect(next.revision).toBe(previous.revision)
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
    expect(isTunnelState({ ...BASE_STATE, revision: 'nope' })).toBe(false)
    expect(isTunnelState(null)).toBe(false)
  })
})
