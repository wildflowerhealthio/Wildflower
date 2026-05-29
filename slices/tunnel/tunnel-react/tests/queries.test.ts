import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { Effect, Layer, SubscriptionRef } from 'effect'
import fc from 'fast-check'
import { BearerToken } from 'kitchen-sink/auth-token'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import {
  applyTunnelOptimistic,
  TUNNEL_STATE_QUERY_KEY,
  tunnelStateQueryOptions,
  type RunAuthed,
  type TunnelState,
} from '../src/queries.ts'

/**
 * Pins the TanStack-Query surface the tunnel slice was migrated onto
 * (Issue #101 Phase 1): the shared `tunnelStateQueryOptions(runAuthed)`
 * factory (consumed by both the route `loader` and the screen), the
 * query key, and the optimistic-projection helper.
 *
 * `runAuthed` is built the same way the app builds it — a real
 * `ManagedRuntime` over `Layer.succeed(BearerToken, ref)` merged with a
 * stub `HttpClient` — so these tests exercise the genuine
 * runner→tunnel-layer→HttpClient path offline. The stub returns a canned
 * `TunnelState` JSON body matching `TunnelStateSchema`.
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

// A stub `HttpClient` that replies with the canned `TunnelState` body
// for GET and 500s otherwise — enough for the GetTunnel read the query
// drives. `failing` makes it always reject so the best-effort loader
// path can be exercised.
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

// Build a `runAuthed` over the given HttpClient stub. Mirrors the app's
// `buildRunAuthed`, kept local so the slice test has no app dependency.
const makeRunAuthed = (httpLayer: Layer.Layer<HttpClient.HttpClient>): RunAuthed => {
  const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('token'))
  return <A, E>(effect: Effect.Effect<A, E, BearerToken | HttpClient.HttpClient>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(Layer.succeed(BearerToken, tokenRef).pipe(Layer.provideMerge(httpLayer))),
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
    // The loader warms the cache; the screen's `useSuspenseQuery` then
    // reads this same entry synchronously.
    expect(queryClient.getQueryData(TUNNEL_STATE_QUERY_KEY)).toEqual(state)
  })

  test('a failed read rejects ensureQueryData (the route loader swallows this)', async () => {
    const options = tunnelStateQueryOptions(makeRunAuthed(stubHttpClientLayer({ failing: true })))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    disposers.push(() => Promise.resolve(queryClient.clear()))

    // `ensureQueryData` rejects on a fetch error. The tunnel route
    // `loader` wraps this in try/catch precisely so an embedded
    // first-paint 401 (token not yet delivered over the bridge) is
    // non-fatal — navigation proceeds and the in-component query reads
    // later, post-gate. This test pins the rejection the loader relies
    // on being able to swallow.
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

  // Property: for any client-writable triple, `undefined` preserves and a
  // present value (incl. null) writes through — the wire schema's
  // "undefined preserves, null clears" contract.
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
      { numRuns: numRunsFor(100) }
    )
  })
})
