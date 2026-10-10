import { HttpClient, HttpClientResponse, UrlParams } from '@effect/platform'
import { RequestLogHttpApiClient } from '@wildflowerhealthio/request-log-core-js/clients'
import { Effect, Layer, Option } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { buildRequestLogClientLayer } from './request-log-client.ts'

describe('buildRequestLogClientLayer', () => {
  test('layer resolves to a RequestLogHttpApiClient that sets no Authorization header', async () => {
    const captures: Array<string | undefined> = []
    const callersLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        captures.push(request.headers['authorization'])
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
          )
        )
      })
    )

    const program = Effect.gen(function* () {
      const client = yield* RequestLogHttpApiClient
      return yield* client.requestLog.ListCallers()
    })

    const layer = buildRequestLogClientLayer().pipe(Layer.provideMerge(callersLayer))

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))

    expect(result).toEqual([])
    expect(captures).toEqual([undefined])
  })

  test('ListRequests sends its filters as query text and decodes the page', async () => {
    const seenQueries: Array<string> = []
    const page = {
      requests: [
        {
          id: 6,
          receivedAt: '2026-07-01T12:00:00Z',
          clientId: 'lifting',
          address: '192.0.2.1',
          servedHost: 'dev1.example.com',
          method: 'GET',
          path: '/fhir-r4/Patient',
          status: 403,
          responseBytes: null,
          durationMs: 12,
          refusal: null,
        },
      ],
      nextCursor: null,
    }
    const pageLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        seenQueries.push(UrlParams.toString(request.urlParams))
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(page), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          )
        )
      })
    )

    const program = Effect.gen(function* () {
      const client = yield* RequestLogHttpApiClient
      return yield* client.requestLog.ListRequests({
        urlParams: { cursor: 7, client: 'lifting', auth: 'authorized' },
      })
    })

    const layer = buildRequestLogClientLayer().pipe(Layer.provideMerge(pageLayer))

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))

    expect(result.requests.map((request) => request.id)).toEqual([6])
    expect(result.requests.map((request) => request.clientId)).toEqual([Option.some('lifting')])
    expect(result.nextCursor).toEqual(Option.none())
    expect(seenQueries).toEqual(['cursor=7&client=lifting&auth=authorized'])
  })
})
