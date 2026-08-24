import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { DateTime, Effect, Layer, Schema } from 'effect'
import type { RunAuthed } from 'fhir-r4-react'
import { buildSmartRouterContext } from 'fhir-r4-react/smart'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'web-trace-core/codec'

import {
  DEFAULT_PAGE_SIZE,
  HAR_ARCHIVE_CATEGORY_TOKEN,
  harArchivesInfiniteQueryOptions,
} from './har-archives.ts'

/**
 * The archive list read, driven over the real
 * query → runner → FHIR-client → `HttpClient` path with a stub transport. Only
 * the transport is a stub; the runner is built through `fhir-r4-react/smart` so a
 * bearer token rides the wire, exactly as a self-hosted app's does. The test can
 * then assert both what the search asked for (the archive category, page size,
 * cursor) and that it went out authenticated.
 */

const SERVER_URL = 'http://127.0.0.1:8080/fhir-r4'
const ACCESS_TOKEN = 'tok-abc'

const queryClients: QueryClient[] = []
let sentRequests: HttpClientRequest.HttpClientRequest[] = []

beforeEach(() => {
  sentRequests = []
})

afterEach(() => {
  for (const queryClient of queryClients.splice(0)) queryClient.clear()
})

describe('harArchivesInfiniteQueryOptions', () => {
  it('should search the har-archive category, with the token, at the default page size', async () => {
    // Arrange
    const queryClient = freshQueryClient()
    const options = harArchivesInfiniteQueryOptions(runAuthedOver([searchset([])]))

    // Act
    await queryClient.fetchInfiniteQuery(options)

    // Assert — the category the codec writes, not the web-trace one
    expect(paramsOf(0)['category']).toBe(HAR_ARCHIVE_CATEGORY_TOKEN)
    expect(HAR_ARCHIVE_CATEGORY_TOKEN).toBe(`${WEB_TRACE_CODE_SYSTEM}|${HAR_ARCHIVE_CODE}`)
    expect(paramsOf(0)['_count']).toBe(String(DEFAULT_PAGE_SIZE))
    // …and it went out authenticated with the granted token
    expect(sentRequests[0]?.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`)
  })

  it('should request the caller page size', async () => {
    // Arrange
    const queryClient = freshQueryClient()
    const options = harArchivesInfiniteQueryOptions(runAuthedOver([searchset([])]), { pageSize: 7 })

    // Act
    await queryClient.fetchInfiniteQuery(options)

    // Assert
    expect(paramsOf(0)['_count']).toBe('7')
  })

  it('should list each archive as a row of its title and upload instant', async () => {
    // Arrange
    const uploadedAt = DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z'))
    const wire = archiveWire({ id: 'archive-1', fileName: 'portal-session.har', uploadedAt })
    const queryClient = freshQueryClient()
    const options = harArchivesInfiniteQueryOptions(runAuthedOver([searchset([wire])]))

    // Act
    const data = await queryClient.fetchInfiniteQuery(options)

    // Assert — read straight off the attachment, without decoding the bytes
    const [page] = data.pages
    expect(page?.archives).toHaveLength(1)
    const row = page?.archives[0]
    expect(row?.id).toBe('archive-1')
    expect(row?.title).toBe('portal-session.har')
    if (row === undefined || row.creation === null) throw new Error('expected a dated row')
    expect(DateTime.toEpochMillis(row.creation)).toBe(DateTime.toEpochMillis(uploadedAt))
  })

  it('should page with the cursor from the bundle next link and stop when there is none', async () => {
    // Arrange
    const uploadedAt = DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z'))
    const first = searchset(
      [archiveWire({ id: 'p1', fileName: 'one.har', uploadedAt })],
      'cursor-2'
    )
    const second = searchset([archiveWire({ id: 'p2', fileName: 'two.har', uploadedAt })])
    const queryClient = freshQueryClient()
    const options = harArchivesInfiniteQueryOptions(runAuthedOver([first, second]))

    // Act
    const data = await queryClient.fetchInfiniteQuery({ ...options, pages: 3 })

    // Assert — the second request carried the cursor, and the third never happened
    expect(sentRequests).toHaveLength(2)
    expect(paramsOf(0)['_pageToken']).toBeUndefined()
    expect(paramsOf(1)['_pageToken']).toBe('cursor-2')
    expect(data.pages.flatMap((page) => page.archives.map((one) => one.id))).toEqual(['p1', 'p2'])
    expect(data.pageParams).toEqual([null, 'cursor-2'])
  })

  it('should reject when the read fails', async () => {
    // Arrange
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClients.push(queryClient)
    const options = harArchivesInfiniteQueryOptions(failingRunAuthed())

    // Act / Assert
    await expect(queryClient.fetchInfiniteQuery(options)).rejects.toThrow()
  })
})

// Helpers

/** Text as base64, the way the archive codec stores the file's bytes. */
const base64 = Schema.encodeSync(Schema.StringFromBase64)

/**
 * One archive `DocumentReference`, as the FHIR JSON a server would send back —
 * hand-built so a jsdom-realm `Uint8Array` never has to satisfy the codec's
 * `instanceof` check. It still carries the archive category coding the list
 * filters on and the attachment title/creation a row reads.
 */
const archiveWire = (fields: {
  readonly id: string
  readonly fileName: string
  readonly uploadedAt: DateTime.Utc
  readonly harText?: string
}): unknown => {
  const iso = DateTime.formatIso(fields.uploadedAt)
  const coding = [{ system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE }]
  return {
    resourceType: 'DocumentReference',
    id: fields.id,
    status: 'current',
    type: { coding },
    category: [{ coding }],
    date: iso,
    content: [
      {
        attachment: {
          contentType: 'application/json',
          data: base64(fields.harText ?? '{"log":{"version":"1.2","entries":[]}}'),
          title: fields.fileName,
          creation: iso,
        },
      },
    ],
  }
}

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
            url: `${SERVER_URL}/DocumentReference?category=har-archive&_pageToken=${nextCursor}`,
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
 * every request, so a test can assert which search the query actually issued and
 * with what credential. A request past the end of `bodies` fails the test.
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

/** A runner carrying the SMART bearer token, over the given stub transport. */
const runAuthedFor = (transport: Layer.Layer<HttpClient.HttpClient>): RunAuthed =>
  buildSmartRouterContext({ serverUrl: SERVER_URL, accessToken: ACCESS_TOKEN }, transport).runAuthed

const runAuthedOver = (bodies: readonly unknown[]): RunAuthed =>
  runAuthedFor(stubHttpClientLayer(bodies))

const failingRunAuthed = (): RunAuthed => runAuthedFor(failingHttpClientLayer())

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
