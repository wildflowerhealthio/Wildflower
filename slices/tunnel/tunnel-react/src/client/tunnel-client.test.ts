import { HttpClient, HttpClientResponse } from '@effect/platform'
import { Effect, Layer, SubscriptionRef } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { Tunnel } from 'tunnel-core/http-api-definition'
import { describe, expect, test } from 'vite-plus/test'

import { isTunnelState } from '../queries.ts'
import { buildTunnelAdminClientLayer } from './tunnel-client.ts'

const STATE_BODY = Tunnel.freshTunnelState

// Stub the request transport with one that captures the outgoing
// `Authorization` header and replies with a canned JSON body matching
// the `TunnelStateViewSchema` shape. The bearer-attaching layer should
// stamp the header from the `BearerToken` Subscribable at request time,
// so flipping the token between two calls must surface as two distinct
// captured values without rebuilding the client layer.
const capturingHttpClientLayer = (
  captures: Array<string | undefined>
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      captures.push(request.headers['authorization'])
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(STATE_BODY), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      )
    })
  )

describe('buildTunnelAdminClientLayer', () => {
  test('layer resolves to a TunnelAdminHttpApiClient', () => {
    const captures: Array<string | undefined> = []
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>(null))

    const program = Effect.gen(function* () {
      const client = yield* TunnelAdminHttpApiClient
      expect(typeof client.tunnel.GetTunnel).toBe('function')
      expect(typeof client.tunnel.ReplaceTunnel).toBe('function')
    })

    const layer = buildTunnelAdminClientLayer().pipe(
      Layer.provideMerge(Layer.succeed(BearerToken, tokenRef)),
      Layer.provideMerge(capturingHttpClientLayer(captures))
    )

    Effect.runSync(program.pipe(Effect.provide(layer)))
  })

  test('attaches Authorization: Bearer <token> on each request', async () => {
    const captures: Array<string | undefined> = []
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('alpha'))

    const program = Effect.gen(function* () {
      const client = yield* TunnelAdminHttpApiClient
      yield* client.tunnel.GetTunnel()
    })

    const layer = buildTunnelAdminClientLayer().pipe(
      Layer.provideMerge(Layer.succeed(BearerToken, tokenRef)),
      Layer.provideMerge(capturingHttpClientLayer(captures))
    )

    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))

    expect(captures).toEqual(['Bearer alpha'])
  })

  test('rotates the token without rebuilding the layer', async () => {
    const captures: Array<string | undefined> = []
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('alpha'))

    const program = Effect.gen(function* () {
      const client = yield* TunnelAdminHttpApiClient
      yield* client.tunnel.GetTunnel()
      yield* SubscriptionRef.set(tokenRef, 'beta')
      yield* client.tunnel.GetTunnel()
    })

    const layer = buildTunnelAdminClientLayer().pipe(
      Layer.provideMerge(Layer.succeed(BearerToken, tokenRef)),
      Layer.provideMerge(capturingHttpClientLayer(captures))
    )

    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))

    expect(captures).toEqual(['Bearer alpha', 'Bearer beta'])
  })

  test('omits Authorization when the token is null', async () => {
    const captures: Array<string | undefined> = []
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>(null))

    const program = Effect.gen(function* () {
      const client = yield* TunnelAdminHttpApiClient
      yield* client.tunnel.GetTunnel()
    })

    const layer = buildTunnelAdminClientLayer().pipe(
      Layer.provideMerge(Layer.succeed(BearerToken, tokenRef)),
      Layer.provideMerge(capturingHttpClientLayer(captures))
    )

    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))

    expect(captures.length).toBe(1)
    expect(captures[0]).toBeUndefined()
  })

  test('ReplaceTunnel sends the full-replace body and the bearer header', async () => {
    const seenBodies: Array<unknown> = []
    const captures: Array<string | undefined> = []
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('alpha'))

    const httpClientLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        captures.push(request.headers['authorization'])
        // The underlying HttpBody discriminates on `_tag`; the
        // `transformClient` chain encodes payloads via `unsafeJson` which
        // produces a `Uint8Array` body. Decode it here so the assertion
        // can compare against the original JSON.
        const body = request.body
        if (body._tag === 'Uint8Array') {
          const text = new TextDecoder().decode(body.body)
          seenBodies.push(JSON.parse(text))
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                ...STATE_BODY,
                settingsRevision: 1,
                publicHost: 'demo',
                requestedRunning: true,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          )
        )
      })
    )

    const program = Effect.gen(function* () {
      const client = yield* TunnelAdminHttpApiClient
      const result = yield* client.tunnel.ReplaceTunnel({
        payload: { settingsRevision: 0, publicHost: 'demo', requestedRunning: true },
      })
      expect(result.publicHost).toBe('demo')
      expect(result.requestedRunning).toBe(true)
      expect(result.settingsRevision).toBe(1)
    })

    const layer = buildTunnelAdminClientLayer().pipe(
      Layer.provideMerge(Layer.succeed(BearerToken, tokenRef)),
      Layer.provideMerge(httpClientLayer)
    )

    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))

    expect(captures).toEqual(['Bearer alpha'])
    expect(seenBodies).toEqual([
      { settingsRevision: 0, publicHost: 'demo', requestedRunning: true },
    ])
  })

  test('ReplaceTunnel surfaces a 409 as the current snapshot in the error channel', async () => {
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('alpha'))

    // 409 returns the *current* snapshot (newer revision, no write applied).
    const conflictLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ ...STATE_BODY, settingsRevision: 99 }), {
              status: 409,
              headers: { 'content-type': 'application/json' },
            })
          )
        )
      )
    )

    const program = Effect.gen(function* () {
      const client = yield* TunnelAdminHttpApiClient
      return yield* Effect.either(
        client.tunnel.ReplaceTunnel({
          payload: { settingsRevision: 0, publicHost: null, requestedRunning: true },
        })
      )
    })

    const layer = buildTunnelAdminClientLayer().pipe(
      Layer.provideMerge(Layer.succeed(BearerToken, tokenRef)),
      Layer.provideMerge(conflictLayer)
    )

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left' && isTunnelState(result.left)) {
      expect(result.left.settingsRevision).toBe(99)
    } else {
      throw new Error('expected the 409 body to decode into the error channel as a TunnelState')
    }
  })
})
