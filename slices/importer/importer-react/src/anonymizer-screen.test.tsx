import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DateTime, Effect, Layer, Schema } from 'effect'
import { FhirR4ResourcesRouterContext, type RunAuthed } from 'fhir-r4-react'
import type * as FhirR4React from 'fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'har-importer-core/archive'
import { emitHar, HarFromJson } from 'har-importer-core/har'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { TraceBody } from 'web-trace-core'
import { CAPTURE_FLOOR, jsonBody, traceExchange } from 'web-trace-core/test-helpers'

import { AnonymizerScreen } from './anonymizer-screen.tsx'

/**
 * The Anonymize surface, end to end over the real screen → picker →
 * `HttpArchive.LogFromHarJson` parse → `AnonymizePanel` path, with only the
 * router seam (`useRunAuthed`) replaced. What this file pins is what an
 * app-level test cannot see: that both a local pick and a server pick reach the
 * download surface with zero writes on the wire (the server pick issues one
 * GET, no writes), and that a non-HAR local file is rejected at the picker.
 */

vi.mock('fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunAuthed }
})

let currentRunAuthed: RunAuthed
let recorded: RecordedRequest[]
let queryClient: QueryClient

// See the same shim in `importer-screen.test.tsx` — jsdom's `TextEncoder`
// returns a foreign-realm `Uint8Array` that the archive codec's
// `Uint8ArrayFromSelf` schema rejects on `instanceof`. Not strictly needed by
// this test (the anonymize path decodes rather than encodes), but the server
// pick's `fetchHarArchive` decodes an attachment through the codec and the
// picker's `acceptLocalHar` reads the local file's bytes — both benefit from
// the single-realm shape a browser has.
const AmbientTextEncoder = globalThis.TextEncoder
class RealmSafeTextEncoder extends AmbientTextEncoder {
  override encode(input?: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(super.encode(input))
  }
}

beforeEach(() => {
  recorded = []
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('TextEncoder', RealmSafeTextEncoder)
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AnonymizerScreen', () => {
  it('should reach the anonymize panel from a locally picked HAR, with no writes on the wire', async () => {
    // Arrange — an empty server list; the HAR comes off the local disk
    currentRunAuthed = routingServer({})
    render(<AnonymizerScreen />, { wrapper: withQueryClient })

    // Act — pick a HAR through the OS picker (single-file input)
    await userEvent.upload(screen.getByLabelText('HAR file'), harFile('portal-session.har'))

    // Assert — the anonymize surface is up and, once the async preview build
    // settles, offers the download.
    expect(await screen.findByRole('region', { name: 'Anonymize' })).toBeDefined()
    expect(await screen.findByRole('button', { name: 'Download anonymized HAR' })).toBeDefined()
    // The whole flow is client-side — no writes and no reads (the empty server
    // list is the only GET that could have gone out, and it did, but nothing
    // wrote).
    expect(writes()).toHaveLength(0)
  })

  it('should reach the anonymize panel from a server-held archive, with a fetch on the wire and no writes', async () => {
    // Arrange — one archive already on the server
    currentRunAuthed = routingServer({
      archives: [{ id: 'archive-1', fileName: 'server-session.har', harText: RECOGNIZED_HAR }],
    })
    render(<AnonymizerScreen />, { wrapper: withQueryClient })

    // Act — click the server row to fetch it, then the panel appears
    await userEvent.click(await screen.findByRole('button', { name: /server-session\.har/ }))

    // Assert — the anonymize surface is up, keyed on the fetched archive
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Anonymize' })).toBeDefined()
    })
    // One GET for the archive-by-id on the wire; zero writes.
    expect(recorded.some((request) => request.url.includes('/DocumentReference/archive-1'))).toBe(
      true
    )
    expect(writes()).toHaveLength(0)
  })

  it('should reject a non-HAR local file at the picker rather than mounting the panel over it', async () => {
    // Arrange
    currentRunAuthed = routingServer({})
    render(<AnonymizerScreen />, { wrapper: withQueryClient })

    // Act — pick a JSON file that is not a HAR (the input's `accept` is
    // `.har,application/json`, so `userEvent.upload` filters `text/plain` out
    // before the picker ever sees it; `acceptLocalHar` is the reject seam under
    // test here).
    const notAHar = new File(['{"not":"a har"}'], 'notes.json', { type: 'application/json' })
    await userEvent.upload(screen.getByLabelText('HAR file'), notAHar)

    // Assert — the picker surfaces the rejection, the panel never mounts, and
    // no writes went out.
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.queryByRole('region', { name: 'Anonymize' })).toBeNull()
    expect(writes()).toHaveLength(0)
  })

  it('should return to the picker on `Pick another`, discarding the previous pick', async () => {
    // Arrange
    currentRunAuthed = routingServer({})
    render(<AnonymizerScreen />, { wrapper: withQueryClient })
    await userEvent.upload(screen.getByLabelText('HAR file'), harFile('portal-session.har'))
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Anonymize' })).toBeDefined()
    })

    // Act — pick another
    await userEvent.click(screen.getByRole('button', { name: 'Pick another' }))

    // Assert — back at the picker, the panel is gone
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'HAR source' })).toBeDefined()
    })
    expect(screen.queryByRole('region', { name: 'Anonymize' })).toBeNull()
    expect(writes()).toHaveLength(0)
  })
})

// Helpers — the same routing-server shape as `importer-screen.test.tsx`, minus
// the resource-write cases (the anonymize surface never writes).

/** A stored FHIR-JSON body, as the capture side would hold it. */
const storedJson = (value: unknown): TraceBody => ({
  _tag: 'StoredBody',
  contentType: 'application/fhir+json',
  data: jsonBody(value),
  size: JSON.stringify(value).length,
  hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
})

/** A minimal FHIR searchset wrapping the given resources. */
const searchsetOf = (...resources: readonly unknown[]): Record<string, unknown> => ({
  resourceType: 'Bundle',
  type: 'searchset',
  total: resources.length,
  entry: resources.map((resource) => ({ resource })),
})

/** A HAR shaped like a real capture — content is not what the anonymize surface cares about; it is that the archive parses. */
const RECOGNIZED_HAR: string = Effect.runSync(
  Schema.encode(HarFromJson)(
    emitHar(
      [
        traceExchange({
          requestId: 'req-0',
          url: 'https://r4.example.org/baseR4/Patient/pat-7?_format=json',
          headers: [['content-type', 'application/fhir+json']],
          body: storedJson({ resourceType: 'Patient', id: 'pat-7' }),
          startedAtMillis: CAPTURE_FLOOR,
        }),
        traceExchange({
          requestId: 'req-1',
          url: 'https://r4.example.org/baseR4/Observation?subject%3APatient=pat-7&_count=250',
          headers: [['content-type', 'application/fhir+json']],
          body: storedJson(
            searchsetOf({
              resourceType: 'Observation',
              id: 'obs-1',
              status: 'final',
              code: { text: 'Weight' },
            })
          ),
          startedAtMillis: CAPTURE_FLOOR + 1000,
        }),
      ],
      { sessionId: 'test-session' }
    )
  )
)

/** A HAR `File`, for the OS-picker (`upload`) path. */
const harFile = (name: string): File =>
  new File([RECOGNIZED_HAR], name, { type: 'application/json' })

/** One request the stub server saw. */
interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body: string
}

/** The write requests recorded so far, in order — the anonymize surface must never produce one. */
const writes = (): readonly RecordedRequest[] =>
  recorded.filter((request) => request.method === 'PUT' || request.method === 'POST')

/** The last path segment of a request URL. */
const idFromUrl = (url: string): string => {
  const path = url.split('?')[0] ?? url
  const segments = path.split('/')
  return segments[segments.length - 1] ?? ''
}

/** Text as base64, the way the archive codec stores the file's bytes. */
const base64 = Schema.encodeSync(Schema.StringFromBase64)

/** One archive `DocumentReference` wire, decodable by the codec and rowable by the list. */
const archiveWire = (fields: {
  readonly id: string
  readonly fileName: string
  readonly harText: string
}): unknown => {
  const coding = [{ system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE }]
  const iso = DateTime.formatIso(DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z')))
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
          data: base64(fields.harText),
          title: fields.fileName,
          creation: iso,
        },
      },
    ],
  }
}

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const decodeBody = (body: HttpClientRequest.HttpClientRequest['body']): string =>
  body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : ''

const routingServer = (config: {
  readonly archives?: readonly {
    readonly id: string
    readonly fileName: string
    readonly harText: string
  }[]
}): RunAuthed => {
  const archives = config.archives ?? []
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const body = decodeBody(request.body)
      recorded.push({ method: request.method, url: request.url, body })
      const params = Object.fromEntries(request.urlParams)
      if (request.method === 'GET' && params['category'] !== undefined) {
        const wires = archives.map((archive) => archiveWire(archive))
        return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(searchset(wires))))
      }
      if (request.method === 'GET') {
        const id = idFromUrl(request.url)
        const archive = archives.find((one) => one.id === id)
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            jsonResponse(
              archiveWire(archive ?? { id, fileName: `${id}.har`, harText: RECOGNIZED_HAR })
            )
          )
        )
      }
      // A write here would fail the test's whole premise.
      const written: unknown = body === '' ? {} : JSON.parse(body)
      return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(written)))
    })
  )
  return <A, E>(
    effect: Effect.Effect<A, E, HttpClient.HttpClient | FhirR4ResourcesHttpApiClient>
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          FhirR4ResourcesRouterContext.sliceRuntimeLayer.pipe(Layer.provideMerge(httpLayer))
        ),
        Effect.scoped
      )
    )
}

const searchset = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [],
})

const withQueryClient = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)
