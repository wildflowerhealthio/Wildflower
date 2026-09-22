import { HttpClient, HttpClientResponse } from '@effect/platform'
import { Effect, Layer } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { attachBearer } from './attach-bearer.ts'

describe('attachBearer', () => {
  test('attaches Authorization header to relative requests when bearer is present', async () => {
    const { seenHeaders, inner } = capturingClientLayer()

    await Effect.flatMap(HttpClient.HttpClient, (client) => client.get('/api/apps')).pipe(
      Effect.provide(attachBearer(inner, () => 'tok_abc')),
      Effect.runPromise
    )

    expect(seenHeaders).toEqual([{ authorization: 'Bearer tok_abc' }])
  })

  test('omits Authorization header when readBearer returns undefined', async () => {
    const { seenHeaders, inner } = capturingClientLayer()

    await Effect.flatMap(HttpClient.HttpClient, (client) => client.get('/api/apps')).pipe(
      Effect.provide(attachBearer(inner, () => undefined)),
      Effect.runPromise
    )

    expect(seenHeaders).toEqual([{}])
  })

  test('does not attach bearer to absolute URLs', async () => {
    const { seenHeaders, inner } = capturingClientLayer()

    await Effect.flatMap(HttpClient.HttpClient, (client) =>
      client.get('https://example.test/api/apps')
    ).pipe(Effect.provide(attachBearer(inner, () => 'tok_abc')), Effect.runPromise)

    expect(seenHeaders).toEqual([{}])
  })

  test('reads bearer lazily at request time, not layer-build time', async () => {
    const { seenHeaders, inner } = capturingClientLayer()
    let token: string | undefined

    const layer = attachBearer(inner, () => token)

    token = 'tok_first'
    await Effect.flatMap(HttpClient.HttpClient, (client) => client.get('/a')).pipe(
      Effect.provide(layer),
      Effect.runPromise
    )

    token = 'tok_second'
    await Effect.flatMap(HttpClient.HttpClient, (client) => client.get('/b')).pipe(
      Effect.provide(layer),
      Effect.runPromise
    )

    expect(seenHeaders).toEqual([
      { authorization: 'Bearer tok_first' },
      { authorization: 'Bearer tok_second' },
    ])
  })

  test('property: absolute URLs never receive an Authorization header', async () => {
    const anyAbsoluteUrl = fc.oneof(
      fc.webUrl(),
      fc.webUrl({ withFragments: true, withQueryParameters: true })
    )

    await fc.assert(
      fc.asyncProperty(anyAbsoluteUrl, fc.string(), async (url, bearer) => {
        const { seenHeaders, inner } = capturingClientLayer()

        await Effect.flatMap(HttpClient.HttpClient, (client) => client.get(url)).pipe(
          Effect.provide(attachBearer(inner, () => bearer)),
          Effect.runPromise
        )

        expect(seenHeaders[0]).toEqual({})
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: relative paths always receive the bearer when one exists', async () => {
    const anyRelativePath = fc
      .tuple(fc.stringMatching(/^[a-z][a-z0-9/.-]*$/), fc.string({ minLength: 1 }))
      .map(([path, token]) => ({ path: `/${path}`, token }))

    await fc.assert(
      fc.asyncProperty(anyRelativePath, async ({ path, token }) => {
        const { seenHeaders, inner } = capturingClientLayer()

        await Effect.flatMap(HttpClient.HttpClient, (client) => client.get(path)).pipe(
          Effect.provide(attachBearer(inner, () => token)),
          Effect.runPromise
        )

        expect(seenHeaders[0]?.authorization).toBe(`Bearer ${token}`)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const capturingClientLayer = (): {
  readonly seenHeaders: Array<Record<string, string>>
  readonly inner: Layer.Layer<HttpClient.HttpClient>
} => {
  const seenHeaders: Array<Record<string, string>> = []
  const inner = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const auth = request.headers.authorization
        seenHeaders.push(auth !== undefined ? { authorization: auth } : {})
        return HttpClientResponse.fromWeb(
          request,
          new Response('[]', { headers: { 'content-type': 'application/json' } })
        )
      })
    )
  )
  return { seenHeaders, inner }
}
