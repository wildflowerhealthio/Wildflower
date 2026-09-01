import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { Effect, Layer, pipe } from 'effect'
import { FhirR4ResourcesRouterContext, type RunAuthed } from 'fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { NO_DOCUMENT_FILTERS } from '../documents/document-filters.ts'
import { DEFAULT_DOCUMENTS_PAGE_SIZE, documentsInfiniteQueryOptions } from './documents.ts'

/**
 * The documents read over the real runner → FHIR-client → `HttpClient` path
 * with a stub transport, mirroring `trace-exchanges.test.ts`.
 *
 * What this read must do that the trace read must not: send **no** category
 * when the reader has not asked for one. A documents browser that quietly
 * pinned a category would be a second recordings tab.
 */

const queryClients: QueryClient[] = []
let sentRequests: HttpClientRequest.HttpClientRequest[] = []

beforeEach(() => {
  sentRequests = []
})

afterEach(() => {
  for (const queryClient of queryClients.splice(0)) queryClient.clear()
})

describe('documentsInfiniteQueryOptions', () => {
  it('should read every category when nothing is narrowed', async () => {
    // Arrange
    const queryClient = freshQueryClient()
    const options = documentsInfiniteQueryOptions(runAuthedOver([searchset([])]))

    // Act
    await queryClient.infiniteQuery(options)

    // Assert — the whole point of the sibling read: no category, no type, no
    // status. A `category=` would search for the empty token and match nothing.
    const params = paramsOf(0)
    expect(params['category']).toBeUndefined()
    expect(params['type']).toBeUndefined()
    expect(params['status']).toBeUndefined()
    expect(params['_count']).toBe(String(DEFAULT_DOCUMENTS_PAGE_SIZE))
  })

  it('should send the active filters as search parameters, narrowing server-side', async () => {
    // Arrange
    const queryClient = freshQueryClient()
    const options = documentsInfiniteQueryOptions(runAuthedOver([searchset([])]), {
      filters: { category: 'http://example.org/docs|discharge', type: '', status: 'current' },
    })

    // Act
    await queryClient.infiniteQuery(options)

    // Assert — the server narrows, not the browser. A read that fetched the
    // whole table and filtered locally would still pass every other assertion
    // here, so this one asserts the wire.
    const params = paramsOf(0)
    expect(params['category']).toBe('http://example.org/docs|discharge')
    expect(params['status']).toBe('current')
    expect(params['type']).toBeUndefined()
  })

  it('should hand back the resources themselves, undecoded, whatever their category', async () => {
    // Arrange — a clinical document, not a web trace. The trace read drops this
    // resource; this read is the one that must not.
    const clinical = documentWire({
      id: 'doc-1',
      category: [{ coding: [{ system: 'http://example.org/docs', code: 'discharge' }] }],
      contentType: 'application/pdf',
    })
    const queryClient = freshQueryClient()
    const options = documentsInfiniteQueryOptions(runAuthedOver([searchset([clinical])]))

    // Act
    const data = await queryClient.infiniteQuery(options)

    // Assert
    const [page] = data.pages
    expect(page?.documents).toHaveLength(1)
    expect(page?.documents[0]?.id).toBe('doc-1')
    expect(page?.documents[0]?.status).toBe('current')
    expect(page?.documents[0]?.content[0]?.attachment.contentType).toBe('application/pdf')
  })

  it('should drop an entry that carries no resource', async () => {
    // Arrange — a searchset entry can be an `outcome` with no resource.
    const queryClient = freshQueryClient()
    const options = documentsInfiniteQueryOptions(
      runAuthedOver([
        {
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [{ resource: documentWire({ id: 'doc-1' }) }, { search: { mode: 'outcome' } }],
          link: [],
        },
      ])
    )

    // Act
    const data = await queryClient.infiniteQuery(options)

    // Assert
    expect(data.pages[0]?.documents.map((document) => document.id)).toEqual(['doc-1'])
  })

  it('should page with the cursor from the bundle next link and stop when there is none', async () => {
    // Arrange
    const first = searchset([documentWire({ id: 'doc-1' })], 'cursor-2')
    const second = searchset([documentWire({ id: 'doc-2' })])
    const queryClient = freshQueryClient()
    const options = documentsInfiniteQueryOptions(runAuthedOver([first, second]))

    // Act
    const data = await queryClient.infiniteQuery({ ...options, pages: 3 })

    // Assert — the second request carried the cursor, and the third never happened
    expect(sentRequests).toHaveLength(2)
    expect(paramsOf(0)['_pageToken']).toBeUndefined()
    expect(paramsOf(1)['_pageToken']).toBe('cursor-2')
    expect(data.pages.flatMap((page) => page.documents.map((one) => one.id))).toEqual([
      'doc-1',
      'doc-2',
    ])
  })

  it('should key two filter sets as two searches rather than one cache entry', () => {
    // Arrange / Act
    const unfiltered = documentsInfiniteQueryOptions(runAuthedOver([]), {
      filters: NO_DOCUMENT_FILTERS,
    })
    const narrowed = documentsInfiniteQueryOptions(runAuthedOver([]), {
      filters: { ...NO_DOCUMENT_FILTERS, status: 'superseded' },
    })

    // Assert — sharing a key would serve the previous search's rows under the
    // new filters until a refetch landed.
    expect(unfiltered.queryKey).not.toEqual(narrowed.queryKey)
  })

  it('should reject when the read fails', async () => {
    // Arrange
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClients.push(queryClient)
    const options = documentsInfiniteQueryOptions(failingRunAuthed())

    // Act / Assert
    await expect(queryClient.infiniteQuery(options)).rejects.toThrow()
  })
})

// Helpers

/** A `DocumentReference` on the wire, with only what a test cares to state. */
const documentWire = (fields: {
  readonly id: string
  readonly category?: readonly unknown[]
  readonly contentType?: string
  readonly status?: 'current' | 'superseded' | 'entered-in-error'
}): unknown => ({
  resourceType: 'DocumentReference',
  id: fields.id,
  status: fields.status ?? 'current',
  ...(fields.category === undefined ? {} : { category: fields.category }),
  content: [
    {
      attachment: {
        contentType: fields.contentType ?? 'application/json',
        data: 'eyJvayI6dHJ1ZX0=',
      },
    },
  ],
})

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
            url: `https://device.local/fhir-r4/DocumentReference?_pageToken=${nextCursor}`,
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
