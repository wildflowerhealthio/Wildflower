import { HttpClient, HttpClientResponse } from '@effect/platform'
import { Effect, Layer } from 'effect'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { Tunnel } from 'tunnel-core/http-api-definition'
import { describe, expect, test } from 'vite-plus/test'

import { isTunnelState } from '../queries.ts'
import { buildTunnelAdminClientLayer } from './tunnel-client.ts'

const STATE_BODY = Tunnel.freshTunnelState

// Stub the request transport with one that captures the outgoing
// `Authorization` header and replies with a canned JSON body matching
// the `TunnelStateViewSchema` shape. The client is tokenless — the host
// app's `HttpClient` layer carries any credential — so with this bare stub
// the captured header must always be `undefined`.
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

    const program = Effect.gen(function* () {
      const client = yield* TunnelAdminHttpApiClient
      expect(typeof client.tunnel.GetTunnel).toBe('function')
      expect(typeof client.tunnel.ReplaceTunnel).toBe('function')
    })

    const layer = buildTunnelAdminClientLayer().pipe(
      Layer.provideMerge(capturingHttpClientLayer(captures))
    )

    Effect.runSync(program.pipe(Effect.provide(layer)))
  })

  test('never sets an Authorization header of its own', async () => {
    const captures: Array<string | undefined> = []

    const program = Effect.gen(function* () {
      const client = yield* TunnelAdminHttpApiClient
      yield* client.tunnel.GetTunnel()
      yield* client.tunnel.GetTunnel()
    })

    const layer = buildTunnelAdminClientLayer().pipe(
      Layer.provideMerge(capturingHttpClientLayer(captures))
    )

    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))

    expect(captures).toEqual([undefined, undefined])
  })

  test('ReplaceTunnel sends the full-replace body and no Authorization header', async () => {
    const seenBodies: Array<unknown> = []
    const captures: Array<string | undefined> = []

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

    const layer = buildTunnelAdminClientLayer().pipe(Layer.provideMerge(httpClientLayer))

    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))

    expect(captures).toEqual([undefined])
    expect(seenBodies).toEqual([
      { settingsRevision: 0, publicHost: 'demo', requestedRunning: true },
    ])
  })

  test('ReplaceTunnel surfaces a 409 as the current snapshot in the error channel', async () => {
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

    const layer = buildTunnelAdminClientLayer().pipe(Layer.provideMerge(conflictLayer))

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left' && isTunnelState(result.left)) {
      expect(result.left.settingsRevision).toBe(99)
    } else {
      throw new Error('expected the 409 body to decode into the error channel as a TunnelState')
    }
  })
})
