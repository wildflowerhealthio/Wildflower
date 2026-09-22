import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { DICOM_SOURCE_FILE_CODE, DICOM_SYSTEM } from 'dicom-importer-core/source-file'
import { DateTime, Effect, Layer, Schema } from 'effect'
import type { RunAuthed } from 'fhir-r4-react'
import { buildSmartRouterContext } from 'fhir-r4-react/smart'
import { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'har-importer-core/source-file'
import {
  LIFELABS_PDF_SOURCE_FILE_CODE,
  LIFELABS_SYSTEM,
} from 'lifelabs-pdf-importer-core/source-file'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import {
  SOURCE_FILES_CATEGORY_TOKEN,
  sourceFilesInfiniteQueryOptions,
  DEFAULT_PAGE_SIZE,
} from './source-files.ts'

/**
 * The source file list read, driven over the real
 * query → runner → FHIR-client → `HttpClient` path with a stub transport.
 * Only the transport is a stub; the runner is built through
 * `fhir-r4-react/smart` so a bearer token rides the wire, exactly as a
 * self-hosted app's does.
 *
 * What this pins that the old HAR-only test could not:
 *   - the search category is the comma-joined `system|code` union across
 *     every registered format, so listing every format's source files is one
 *     round trip per page;
 *   - a mixed searchset (a HAR source file plus a LifeLabs PDF source file)
 *     surfaces as rows tagged with the format each was classified as by
 *     the importer's `isSourceFile` predicate;
 *   - a resource whose category coding is neither format's is dropped
 *     from the rows.
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

describe('sourceFilesInfiniteQueryOptions', () => {
  it('should search the comma-joined source file category over every registered format, sized and authed', async () => {
    // Arrange
    const queryClient = freshQueryClient()
    const options = sourceFilesInfiniteQueryOptions(runAuthedOver([searchset([])]))

    // Act
    await queryClient.infiniteQuery(options)

    // Assert — one search, one comma-joined `system|code` covering both formats
    expect(paramsOf(0)['category']).toBe(SOURCE_FILES_CATEGORY_TOKEN)
    expect(SOURCE_FILES_CATEGORY_TOKEN).toBe(
      `${WEB_TRACE_CODE_SYSTEM}|${HAR_ARCHIVE_CODE},${LIFELABS_SYSTEM}|${LIFELABS_PDF_SOURCE_FILE_CODE},${DICOM_SYSTEM}|${DICOM_SOURCE_FILE_CODE}`
    )
    expect(paramsOf(0)['_count']).toBe(String(DEFAULT_PAGE_SIZE))
    // …and it went out authenticated with the granted token
    expect(sentRequests[0]?.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`)
  })

  it('should tag each row with the format its category coding claims', async () => {
    // Arrange — one HAR and one LifeLabs PDF in the same searchset, plus a
    // resource whose category is a DocumentReference not from any format
    const uploadedAt = DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z'))
    const rows = [
      harArchiveWire({ id: 'har-1', fileName: 'session.har', uploadedAt }),
      lifelabsPdfArchiveWire({ id: 'pdf-1', fileName: 'report.pdf', uploadedAt }),
      unrelatedDocumentWire({ id: 'other-1', fileName: 'notes.txt' }),
    ]
    const queryClient = freshQueryClient()
    const options = sourceFilesInfiniteQueryOptions(runAuthedOver([searchset(rows)]))

    // Act
    const data = await queryClient.infiniteQuery(options)

    // Assert — the unrelated resource is dropped; the remaining rows carry
    // the right format tag by their classification
    const page = data.pages[0]
    if (page === undefined) throw new Error('expected a page')
    expect(page.sourceFiles.map((row) => ({ id: row.id, format: row.format }))).toEqual([
      { id: 'har-1', format: 'har' },
      { id: 'pdf-1', format: 'lifelabs-pdf' },
    ])
  })

  it("should date each row by the stored resource's own meta.lastUpdated", async () => {
    // The source file states no instant of its own; when the file reached the
    // device is the server's to know.
    const uploadedAt = DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z'))
    const queryClient = freshQueryClient()
    const data = await queryClient.infiniteQuery(
      sourceFilesInfiniteQueryOptions(
        runAuthedOver([
          searchset([
            harArchiveWire({ id: 'har-1', fileName: 'session.har', uploadedAt }),
            undatedHarArchiveWire({ id: 'har-2', fileName: 'undated.har' }),
          ]),
        ])
      )
    )
    expect(data.pages[0]?.sourceFiles.map((row) => row.lastUpdated)).toEqual([uploadedAt, null])
  })

  it('should page with the cursor from the bundle next link and stop when there is none', async () => {
    // Arrange
    const uploadedAt = DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z'))
    const first = searchset(
      [harArchiveWire({ id: 'p1', fileName: 'one.har', uploadedAt })],
      'cursor-2'
    )
    const second = searchset([
      lifelabsPdfArchiveWire({ id: 'p2', fileName: 'two.pdf', uploadedAt }),
    ])
    const queryClient = freshQueryClient()
    const options = sourceFilesInfiniteQueryOptions(runAuthedOver([first, second]))

    // Act
    const data = await queryClient.infiniteQuery({ ...options, pages: 3 })

    // Assert — the second request carried the cursor, and the third never happened
    expect(sentRequests).toHaveLength(2)
    expect(paramsOf(0)['_pageToken']).toBeUndefined()
    expect(paramsOf(1)['_pageToken']).toBe('cursor-2')
    expect(data.pages.flatMap((page) => page.sourceFiles.map((one) => one.id))).toEqual([
      'p1',
      'p2',
    ])
    expect(data.pageParams).toEqual([null, 'cursor-2'])
  })

  it('should reject when the read fails', async () => {
    // Arrange
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClients.push(queryClient)
    const options = sourceFilesInfiniteQueryOptions(failingRunAuthed())

    // Act / Assert
    await expect(queryClient.infiniteQuery(options)).rejects.toThrow()
  })
})

// Helpers

/** Text as base64, the way the source file codec stores the file's bytes. */
const base64 = Schema.encodeSync(Schema.StringFromBase64)

/**
 * One HAR archive `DocumentReference`, as the FHIR JSON a server would
 * send back — hand-built so a jsdom-realm `Uint8Array` never has to
 * satisfy the codec's `instanceof` check.
 */
const harArchiveWire = (fields: {
  readonly id: string
  readonly fileName: string
  readonly uploadedAt: DateTime.Utc
}): unknown => {
  const iso = DateTime.formatIso(fields.uploadedAt)
  const coding = [{ system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE }]
  return {
    resourceType: 'DocumentReference',
    id: fields.id,
    status: 'current',
    meta: { lastUpdated: iso },
    type: { coding },
    category: [{ coding }],
    content: [
      {
        attachment: {
          contentType: 'application/json',
          data: base64('{"log":{"version":"1.2","entries":[]}}'),
          title: fields.fileName,
        },
      },
    ],
  }
}

/** One LifeLabs PDF source file `DocumentReference`, hand-built the same way. */
const lifelabsPdfArchiveWire = (fields: {
  readonly id: string
  readonly fileName: string
  readonly uploadedAt: DateTime.Utc
}): unknown => {
  const iso = DateTime.formatIso(fields.uploadedAt)
  const coding = [{ system: LIFELABS_SYSTEM, code: LIFELABS_PDF_SOURCE_FILE_CODE }]
  return {
    resourceType: 'DocumentReference',
    id: fields.id,
    status: 'current',
    meta: { lastUpdated: iso },
    type: { coding },
    category: [{ coding }],
    content: [
      {
        attachment: {
          contentType: 'application/pdf',
          // Minimal `%PDF-` bytes; the query never decodes them, so any
          // base64 payload with a title suffices.
          data: base64('%PDF-1.4\n'),
          title: fields.fileName,
        },
      },
    ],
  }
}

/** A HAR archive the server states no `meta.lastUpdated` for. */
const undatedHarArchiveWire = (fields: {
  readonly id: string
  readonly fileName: string
}): unknown => {
  const coding = [{ system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE }]
  return {
    resourceType: 'DocumentReference',
    id: fields.id,
    status: 'current',
    type: { coding },
    category: [{ coding }],
    content: [
      {
        attachment: {
          contentType: 'application/json',
          data: base64('{"log":{"version":"1.2","entries":[]}}'),
          title: fields.fileName,
        },
      },
    ],
  }
}

/**
 * A `DocumentReference` whose category matches *neither* registered
 * format — the server search returns it as noise (a code that starts
 * with `har-archive` in a different system, say, or an unrelated code
 * altogether). The query must drop it.
 */
const unrelatedDocumentWire = (fields: {
  readonly id: string
  readonly fileName: string
}): unknown => {
  const coding = [{ system: 'https://example.invalid/other', code: 'not-an-archive' }]
  return {
    resourceType: 'DocumentReference',
    id: fields.id,
    status: 'current',
    type: { coding },
    category: [{ coding }],
    content: [{ attachment: { contentType: 'text/plain', title: fields.fileName } }],
  }
}

/** A `searchset` bundle, optionally with a next cursor. */
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
            url: `${SERVER_URL}/DocumentReference?category=any&_pageToken=${nextCursor}`,
          },
        ],
})

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

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

const paramsOf = (index: number): Readonly<Record<string, string | undefined>> => {
  const request = sentRequests[index]
  if (request === undefined) throw new Error(`no request recorded at index ${index}`)
  return Object.fromEntries(request.urlParams)
}
