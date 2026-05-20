import { HttpClient, HttpClientResponse } from '@effect/platform'
import { Effect, Layer, SubscriptionRef } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { describe, expect, test } from 'vite-plus/test'

import { buildTunnelAdminClientLayer } from '../src/client/tunnel-client.ts'

// Stub the request transport with one that captures the outgoing
// `Authorization` header and replies with a canned JSON body matching
// the `TunnelStateSchema` shape. The bearer-attaching layer should
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
          new Response(
            JSON.stringify({
              subdomain: null,
              rootDomain: null,
              localPort: null,
              requestedRunning: false,
              running: false,
              currentSubdomain: null,
              currentRootDomain: null,
              currentLocalPort: null,
              error: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
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
      expect(typeof client.tunnel.PatchTunnel).toBe('function')
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

  test('PatchTunnel sends the payload body and the bearer header', async () => {
    const seenBodies: Array<unknown> = []
    const captures: Array<string | undefined> = []
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('alpha'))

    const httpClientLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        captures.push(request.headers['authorization'])
        // The underlying HttpBody discriminates on `_tag`; the
        // `transformClient` chain encodes PATCH payloads via
        // `unsafeJson` which produces a `Uint8Array` body. Decode it
        // here so the assertion can compare against the original JSON.
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
                subdomain: 'demo',
                rootDomain: null,
                localPort: null,
                requestedRunning: true,
                running: false,
                currentSubdomain: null,
                currentRootDomain: null,
                currentLocalPort: null,
                error: null,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          )
        )
      })
    )

    const program = Effect.gen(function* () {
      const client = yield* TunnelAdminHttpApiClient
      const result = yield* client.tunnel.PatchTunnel({
        payload: { requestedRunning: true, subdomain: 'demo' },
      })
      expect(result.subdomain).toBe('demo')
      expect(result.requestedRunning).toBe(true)
    })

    const layer = buildTunnelAdminClientLayer().pipe(
      Layer.provideMerge(Layer.succeed(BearerToken, tokenRef)),
      Layer.provideMerge(httpClientLayer)
    )

    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))

    expect(captures).toEqual(['Bearer alpha'])
    expect(seenBodies).toEqual([{ requestedRunning: true, subdomain: 'demo' }])
  })
})
