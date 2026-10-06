import { HttpClient, HttpClientResponse } from '@effect/platform'
import { Effect, Layer } from 'effect'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { Tunnel } from 'tunnel-core/http-api-definition'
import { describe, expect, test } from 'vite-plus/test'

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
      // Read-only: the client can read the tunnel, and has no way to write it.
      expect(Object.keys(client.tunnel)).toEqual(['GetTunnel'])
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
})
