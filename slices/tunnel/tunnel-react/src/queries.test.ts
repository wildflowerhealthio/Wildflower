import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { Effect, Layer, pipe, SubscriptionRef } from 'effect'
import fc from 'fast-check'
import { BearerToken } from 'kitchen-sink/auth-token'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import {
  applyTunnelOptimistic,
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
  subdomain: null,
  rootDomain: null,
  requestedRunning: false,
  running: false,
  currentSubdomain: null,
  currentRootDomain: null,
  currentLocalPort: null,
  error: null,
  servedOrigin: 'http://127.0.0.1:8080',
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

describe('applyTunnelOptimistic', () => {
  const baseState: TunnelState = {
    ...TUNNEL_STATE_BODY,
    subdomain: 'old-sub',
    rootDomain: 'old.example.com',
    requestedRunning: false,
  }

  test('an undefined field preserves the previous value', () => {
    const next = applyTunnelOptimistic(baseState, {})
    expect(next.subdomain).toBe('old-sub')
    expect(next.rootDomain).toBe('old.example.com')
    expect(next.requestedRunning).toBe(false)
  })

  test('an explicit null clears the field (null != undefined)', () => {
    const next = applyTunnelOptimistic(baseState, { subdomain: null })
    expect(next.subdomain).toBeNull()
    // untouched
    expect(next.rootDomain).toBe('old.example.com')
  })

  test('never touches server-derived fields', () => {
    const next = applyTunnelOptimistic(
      { ...baseState, running: true, currentSubdomain: 'live', servedOrigin: 'http://live' },
      { subdomain: 'x', requestedRunning: true }
    )
    expect(next.running).toBe(true)
    expect(next.currentSubdomain).toBe('live')
    expect(next.servedOrigin).toBe('http://live')
  })

  test('client-writable fields follow undefined-preserves / present-writes', () => {
    const optionalString = fc.option(fc.string(), { nil: null })
    fc.assert(
      fc.property(
        optionalString,
        optionalString,
        fc.option(optionalString, { nil: undefined }),
        fc.option(optionalString, { nil: undefined }),
        fc.option(fc.boolean(), { nil: undefined }),
        (prevSub, prevRoot, paySub, payRoot, payRun) => {
          const previous: TunnelState = {
            ...baseState,
            subdomain: prevSub,
            rootDomain: prevRoot,
            requestedRunning: false,
          }
          const next = applyTunnelOptimistic(previous, {
            subdomain: paySub,
            rootDomain: payRoot,
            requestedRunning: payRun,
          })
          expect(next.subdomain).toBe(paySub === undefined ? prevSub : paySub)
          expect(next.rootDomain).toBe(payRoot === undefined ? prevRoot : payRoot)
          expect(next.requestedRunning).toBe(payRun === undefined ? false : payRun)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
