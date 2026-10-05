import { createHash, createHmac } from 'node:crypto'

import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Context, Effect, Either, Layer } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { AdminKeyStore, importAdminKey } from '../key-store/index.ts'
import { signingHttpClient } from './signing-http-client.ts'

const ADMIN_KEY = 'an-admin-key-of-thirty-two-bytes'
const ORIGIN = 'https://admin.relay.example.com'

/** A transport that records each request it is handed and answers `204`. */
const recordingTransport = (
  sent: HttpClientRequest.HttpClientRequest[]
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      sent.push(request)
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))
      )
    })
  )

/** The signing client over `transport`, with `key` stored (or none). */
const signingClient = (
  transport: Layer.Layer<HttpClient.HttpClient>,
  key: string | undefined
): Layer.Layer<HttpClient.HttpClient> => {
  const store = Layer.tap(AdminKeyStore.layerMemory, (context) =>
    key === undefined
      ? Effect.void
      : Effect.flatMap(importAdminKey(key), (imported) =>
          Context.get(context, AdminKeyStore).save(imported)
        )
  )
  return signingHttpClient(ORIGIN).pipe(Layer.provide(Layer.merge(transport, Layer.orDie(store))))
}

describe('signingHttpClient', () => {
  it('sends a relative request to the absolute URL it signed, with a MAC the relay accepts', async () => {
    // Arrange
    const sent: HttpClientRequest.HttpClientRequest[] = []
    const body = { email: 'bob@example.com', name: 'bob' }
    const request = HttpClientRequest.post('/api/tunnels').pipe(
      HttpClientRequest.bodyUnsafeJson(body)
    )

    // Act
    await Effect.runPromise(
      HttpClient.execute(request).pipe(
        Effect.provide(signingClient(recordingTransport(sent), ADMIN_KEY))
      )
    )

    // Assert
    expect(sent).toHaveLength(1)
    const [signed] = sent
    expect(signed?.url).toBe(`${ORIGIN}/api/tunnels`)
    const headers = signed?.headers ?? {}
    const digest = `sha-256=:${createHash('sha256').update(JSON.stringify(body)).digest('base64')}:`
    expect(headers['content-digest']).toBe(digest)
    const params = headers['signature-input']?.replace(/^sig=/, '') ?? ''
    expect(params).toMatch(
      /^\("@method" "@target-uri" "content-digest"\);created=\d+;nonce="[\w-]{22}";keyid="admin";alg="hmac-sha256"$/
    )
    const base = [
      '"@method": POST',
      `"@target-uri": ${ORIGIN}/api/tunnels`,
      `"content-digest": ${digest}`,
      `"@signature-params": ${params}`,
    ].join('\n')
    expect(headers['signature']).toBe(
      `sig=:${createHmac('sha256', ADMIN_KEY).update(base).digest('base64')}:`
    )
  })

  it('gives every request its own nonce', async () => {
    // Arrange
    const sent: HttpClientRequest.HttpClientRequest[] = []

    // Act
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.get('/api/tunnels')
        yield* client.get('/api/tunnels')
      }).pipe(Effect.provide(signingClient(recordingTransport(sent), ADMIN_KEY)))
    )

    // Assert
    const nonces = sent.map(
      (request) => /nonce="([^"]+)"/.exec(request.headers['signature-input'] ?? '')?.[1]
    )
    expect(nonces).toHaveLength(2)
    expect(nonces[0]).not.toBe(nonces[1])
  })

  it('sends nothing without a stored key, failing with the reason', async () => {
    // Arrange
    const sent: HttpClientRequest.HttpClientRequest[] = []

    // Act
    const result = await Effect.runPromise(
      Effect.either(
        HttpClient.get('/api/tunnels').pipe(
          Effect.provide(signingClient(recordingTransport(sent), undefined))
        )
      )
    )

    // Assert
    expect(sent).toEqual([])
    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: 'RequestError',
      reason: 'Encode',
      cause: { _tag: 'NoAdminKey' },
    })
  })
})
