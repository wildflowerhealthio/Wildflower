import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { Effect, Layer, pipe } from 'effect'
import { FhirR4ResourcesRouterContext, type RunAuthed } from 'fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { traceExchangeToWire, WEB_TRACE_CODE_SYSTEM } from 'web-trace-core/codec'
import { traceExchange } from 'web-trace-core/test-helpers'

import {
  DEFAULT_PAGE_SIZE,
  traceExchangesInfiniteQueryOptions,
  WEB_TRACE_CATEGORY_TOKEN,
} from './trace-exchanges.ts'

const queryClients: QueryClient[] = []
let sentRequests: HttpClientRequest.HttpClientRequest[] = []

beforeEach(() => {
  sentRequests = []
})

afterEach(() => {
  for (const queryClient of queryClients.splice(0)) queryClient.clear()
})

describe('traceExchangesInfiniteQueryOptions', () => {
  it('should search by the web-trace category rather than reading the whole table', async () => {
    // Arrange
    const queryClient = freshQueryClient()
    const options = traceExchangesInfiniteQueryOptions(runAuthedOver([searchset([])]))

    // Act
    await queryClient.fetchInfiniteQuery(options)

    // Assert
    expect(paramsOf(0)['category']).toBe(WEB_TRACE_CATEGORY_TOKEN)
    expect(WEB_TRACE_CATEGORY_TOKEN).toBe(`${WEB_TRACE_CODE_SYSTEM}|web-trace`)
    expect(paramsOf(0)['_count']).toBe(String(DEFAULT_PAGE_SIZE))
  })

  it('should request the caller page size', async () => {
    // Arrange
    const queryClient = freshQueryClient()
    const options = traceExchangesInfiniteQueryOptions(runAuthedOver([searchset([])]), {
      pageSize: 7,
    })

    // Act
    await queryClient.fetchInfiniteQuery(options)

    // Assert
    expect(paramsOf(0)['_count']).toBe('7')
  })

  it('should decode each trace resource back into the exchange it was written from', async () => {
    // Arrange
    const captured = traceExchange({
      sessionId: 'session-2f8c',
      requestId: 'req-1',
      url: 'https://portal.example.org/api/v2/patients/9f3',
      status: 200,
    })
    const queryClient = freshQueryClient()
    const options = traceExchangesInfiniteQueryOptions(
      runAuthedOver([searchset([traceExchangeToWire(captured)])])
    )

    // Act
    const data = await queryClient.fetchInfiniteQuery(options)

    // Assert
    const [page] = data.pages
    expect(page?.exchanges).toHaveLength(1)
    expect(page?.exchanges[0]?.sessionId).toBe('session-2f8c')
    expect(page?.exchanges[0]?.requestId).toBe('req-1')
    expect(page?.exchanges[0]?.url).toBe('https://portal.example.org/api/v2/patients/9f3')
    expect(page?.exchanges[0]?.status).toBe(200)
    expect(page?.unreadable).toBe(0)
  })

  it('should count a trace resource it cannot decode and keep the rest of the page', async () => {
    // Arrange — a trace resource with no identifiers has no session id to decode.
    const readable = traceExchangeToWire(traceExchange({ requestId: 'good' }))
    const { identifier: _dropped, ...unreadable } = traceExchangeToWire(
      traceExchange({ requestId: 'bad' })
    )
    const queryClient = freshQueryClient()
    const options = traceExchangesInfiniteQueryOptions(
      runAuthedOver([searchset([readable, unreadable])])
    )

    // Act
    const data = await queryClient.fetchInfiniteQuery(options)

    // Assert — a partial page is reported as partial, not presented as complete
    const [page] = data.pages
    expect(page?.exchanges.map((exchange) => exchange.requestId)).toEqual(['good'])
    expect(page?.unreadable).toBe(1)
  })

  it('should drop a DocumentReference from another category without calling it unreadable', async () => {
    // Arrange
    const clinical = {
      ...traceExchangeToWire(traceExchange({ requestId: 'clinical' })),
      category: [{ coding: [{ system: 'http://example.org/CodeSystem/docs', code: 'discharge' }] }],
    }
    const queryClient = freshQueryClient()
    const options = traceExchangesInfiniteQueryOptions(runAuthedOver([searchset([clinical])]))

    // Act
    const data = await queryClient.fetchInfiniteQuery(options)

    // Assert — not a trace at all, so neither listed nor counted as a failure
    const [page] = data.pages
    expect(page?.exchanges).toEqual([])
    expect(page?.unreadable).toBe(0)
  })

  it('should page with the cursor from the bundle next link and stop when there is none', async () => {
    // Arrange
    const first = searchset([traceExchangeToWire(traceExchange({ requestId: 'p1' }))], 'cursor-2')
    const second = searchset([traceExchangeToWire(traceExchange({ requestId: 'p2' }))])
    const queryClient = freshQueryClient()
    const options = traceExchangesInfiniteQueryOptions(runAuthedOver([first, second]))

    // Act
    const data = await queryClient.fetchInfiniteQuery({ ...options, pages: 3 })

    // Assert — the second request carried the cursor, and the third never happened
    expect(sentRequests).toHaveLength(2)
    expect(paramsOf(0)['_pageToken']).toBeUndefined()
    expect(paramsOf(1)['_pageToken']).toBe('cursor-2')
    expect(data.pages.flatMap((page) => page.exchanges.map((one) => one.requestId))).toEqual([
      'p1',
      'p2',
    ])
    expect(data.pageParams).toEqual([null, 'cursor-2'])
  })

  it('should reject when the read fails', async () => {
    // Arrange
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClients.push(queryClient)
    const options = traceExchangesInfiniteQueryOptions(failingRunAuthed())

    // Act / Assert
    await expect(queryClient.fetchInfiniteQuery(options)).rejects.toThrow()
  })
})

// Helpers

/** A `searchset` bundle over already-encoded FHIR resources, optionally with a next cursor. */
const searchset = (resources: readonly unknown[], nextCursor?: string): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link:
    nextCursor === undefined
      ? []
      : [
          {
            relation: 'next',
            url: `https://device.local/fhir-r4/DocumentReference?category=web-trace&_pageToken=${nextCursor}`,
          },
        ],
})

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/**
 * An `HttpClient` that answers the nth request with the nth body and records
 * every request, so a test can assert which search the query actually issued.
 * A request past the end of `bodies` fails the test rather than looping.
 */
const stubHttpClientLayer = (bodies: readonly unknown[]): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const body = bodies[sentRequests.length]
      sentRequests.push(request)
      if (body === undefined) return Effect.die(new Error('unexpected extra request'))
      return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(body)))
    })
  )

const failingHttpClientLayer = (): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 500 })))
    )
  )

/** Mirrors the app's `buildRunAuthed`, kept local so the slice has no app dependency. */
const makeRunAuthed = (httpLayer: Layer.Layer<HttpClient.HttpClient>): RunAuthed => {
  return <A, E>(
    effect: Effect.Effect<A, E, HttpClient.HttpClient | FhirR4ResourcesHttpApiClient>
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          pipe(FhirR4ResourcesRouterContext.sliceRuntimeLayer, Layer.provideMerge(httpLayer))
        ),
        Effect.scoped
      )
    )
}

const runAuthedOver = (bodies: readonly unknown[]): RunAuthed =>
  makeRunAuthed(stubHttpClientLayer(bodies))

const failingRunAuthed = (): RunAuthed => makeRunAuthed(failingHttpClientLayer())

const freshQueryClient = (): QueryClient => {
  const queryClient = new QueryClient()
  queryClients.push(queryClient)
  return queryClient
}

/** The search parameters of the nth recorded request, as a plain lookup. */
const paramsOf = (index: number): Readonly<Record<string, string | undefined>> => {
  const request = sentRequests[index]
  if (request === undefined) throw new Error(`no request recorded at index ${index}`)
  return Object.fromEntries(request.urlParams)
}
