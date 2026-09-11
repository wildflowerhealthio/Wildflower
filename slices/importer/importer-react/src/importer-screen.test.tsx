import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DateTime, Effect, Layer, Schema } from 'effect'
import { FhirR4ResourcesRouterContext, type RunAuthed } from 'fhir-r4-react'
import type * as FhirR4React from 'fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'har-importer-core/archive'
import { emitHar, HarFromJson } from 'http-archive'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { TraceBody } from 'web-trace-core'
import { CAPTURE_FLOOR, jsonBody, traceExchange } from 'web-trace-core/test-helpers'

import { ImporterScreen } from './importer-screen.tsx'

/**
 * The whole preview-then-confirm flow, driven end-to-end over the real
 * screen → hooks → FHIR-client → `HttpClient` path with a recording stub
 * transport. Only the router seam (`useRunAuthed`) is replaced — the
 * `documents-panel.test.tsx` pattern — so every request the flow issues lands in
 * one ordered log the tests read.
 *
 * The load-bearing assertions are the opt-in seam itself:
 *
 * - **the preview issues no writes** — reaching a preview touches the server only
 *   for the source list; the archive create and every resource write appear only
 *   after an explicit confirm;
 * - **confirm's ordering is fixed** — the HAR-archive create lands before the
 *   first resource write, and every resource write body carries `meta.source`
 *   naming that archive (a server-sourced HAR uploads nothing and links to the
 *   document it was fetched from);
 * - **a failing write folds into a partial result**, and **cancel discards with
 *   no writes**.
 */

vi.mock('fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunAuthed }
})

let currentRunAuthed: RunAuthed
let recorded: RecordedRequest[]
let queryClient: QueryClient

/**
 * jsdom's `TextEncoder` hands back a `Uint8Array` from a realm the archive codec's
 * `Uint8ArrayFromSelf` schema rejects on `instanceof` — a purely jsdom artifact,
 * since a browser has one realm and a real capture's bytes always satisfy the
 * check. Re-wrapping the encoder's output through the ambient `Uint8Array` (the
 * one the schema is checked against, per `upload-har.test`) reproduces the
 * single-realm behaviour the confirm step's local-upload encode has in a browser.
 */
const AmbientTextEncoder = globalThis.TextEncoder
class RealmSafeTextEncoder extends AmbientTextEncoder {
  override encode(input?: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(super.encode(input))
  }
}

// jsdom doesn't implement the native <dialog> element that `react-tundraish`'s
// Dialog reaches for. Patch the two methods per-test and restore the original
// descriptors after so the patches don't leak across files.
const originalShowModalDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'showModal'
)
const originalCloseDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'close'
)
const restoreDialogMethod = (
  key: 'showModal' | 'close',
  descriptor: PropertyDescriptor | undefined
): void => {
  if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, key)
  else Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
}

beforeEach(() => {
  recorded = []
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('TextEncoder', RealmSafeTextEncoder)
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(): void {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  restoreDialogMethod('showModal', originalShowModalDescriptor)
  restoreDialogMethod('close', originalCloseDescriptor)
})

describe('ImporterScreen', () => {
  it('issues zero writes to reach a preview, and only writes after an explicit confirm', async () => {
    // Arrange — an empty server list; the HAR is picked from a local file
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act — pick a recognized HAR through the OS picker
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))

    // Assert — the preview is up, and NOT ONE write went out to reach it
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Ready to import/ })).toBeDefined()
    })
    expect(writes()).toHaveLength(0)
    // The two recognized responses are named in the interactive review (per URL).
    expect(screen.getByText(/\/Patient\/pat-7/)).toBeDefined()
    expect(screen.getByText(/\/Observation\?/)).toBeDefined()

    // Act — confirm (two chosen responses → one Patient + two Observations written)
    await userEvent.click(screen.getByRole('button', { name: /Import 3 resources/ }))

    // Assert — writes appear only now
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Import complete/ })).toBeDefined()
    })
    expect(writes().length).toBeGreaterThan(0)
  })

  it('uploads the HAR archive before the first resource write and stamps every resource with it', async () => {
    // Arrange
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act — pick locally, then confirm
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Ready to import/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /Import 3 resources/ }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Import complete/ })).toBeDefined()
    })

    // Assert — one HAR-archive create, and it lands before the first resource write
    const archiveCreate = writes().findIndex((write) => write.url.includes('/DocumentReference/'))
    const firstResource = writes().findIndex((write) => isResourceWrite(write))
    expect(archiveCreate).toBeGreaterThanOrEqual(0)
    expect(firstResource).toBeGreaterThan(archiveCreate)

    // …and every resource write points its `meta.source` at that fresh archive
    const archiveId = idFromUrl(writes()[archiveCreate]?.url ?? '')
    const expectedSource = `DocumentReference/${archiveId}`
    const resourceWrites = writes().filter(isResourceWrite)
    expect(resourceWrites).toHaveLength(3)
    for (const write of resourceWrites) {
      expect(JSON.parse(write.body)).toMatchObject({ meta: { source: expectedSource } })
    }
  })

  it('links a server-sourced HAR to the fetched document and creates no archive', async () => {
    // Arrange — one archive already on the server, carrying the recognized HAR
    currentRunAuthed = routingServer({
      archives: [{ id: 'archive-1', fileName: 'server-session.har', harText: RECOGNIZED_HAR }],
    })
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act — select it from the server list, then confirm
    await userEvent.click(await screen.findByRole('button', { name: /server-session\.har/ }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Ready to import/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /Import 3 resources/ }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Import complete/ })).toBeDefined()
    })

    // Assert — no DocumentReference *create* (the archive already exists), and
    // every resource links to the document it was fetched from
    expect(writes().some((write) => write.url.includes('/DocumentReference/'))).toBe(false)
    const resourceWrites = writes().filter(isResourceWrite)
    expect(resourceWrites).toHaveLength(3)
    for (const write of resourceWrites) {
      expect(JSON.parse(write.body)).toMatchObject({
        meta: { source: 'DocumentReference/archive-1' },
      })
    }
  })

  it('folds a failing write into a partial result that lists the failed resource', async () => {
    // Arrange — the store rejects every Observation write
    currentRunAuthed = routingServer({
      failWrite: (request) => request.url.includes('/Observation/'),
    })
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Ready to import/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /Import 3 resources/ }))

    // Assert — a partial result: the Patient wrote, both Observations are listed
    // as failures (retry backoff runs on the real clock, so allow for it)
    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: /Imported with some failures/ })).toBeDefined()
      },
      { timeout: 6000 }
    )
    const failures = screen.getByRole('alert')
    expect(failures.textContent).toMatch(/Observation\//)
    expect(screen.getByRole('status').textContent).toMatch(/Wrote 1 of 3/)
  })

  it("surfaces a file's upload failure cause and writes none of its resources", async () => {
    // Arrange — the store rejects the archive `DocumentReference` upload, so the
    // file's whole write fails before any resource is stamped.
    currentRunAuthed = routingServer({
      failWrite: (request) => request.url.includes('/DocumentReference/'),
    })
    const { container } = render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act — pick locally, then confirm
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Ready to import/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /Import 3 resources/ }))

    // Assert — a partial result naming the failed file and showing the underlying
    // cause rather than hiding it, and the failed archive means no resource wrote.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Imported with some failures/ })).toBeDefined()
    })
    expect(screen.getByText(/its archive could not be uploaded/i)).toBeDefined()
    const detail = container.querySelector('pre')
    expect((detail?.textContent ?? '').length).toBeGreaterThan(0)
    expect(writes().some(isResourceWrite)).toBe(false)
  })

  it('imports several files at once as one batch, each stamped with its own archive', async () => {
    // Arrange
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act — choose two recognized HARs in one dialog, preview them together
    await userEvent.upload(screen.getByLabelText('Import file'), [
      harFile('session-a.har'),
      harFile('session-b.har'),
    ])
    await waitFor(() => {
      // Two files × three resources previewed under one confirm.
      expect(screen.getByRole('button', { name: /Import 6 resources/ })).toBeDefined()
    })
    expect(writes()).toHaveLength(0)

    // Confirm the whole batch
    await userEvent.click(screen.getByRole('button', { name: /Import 6 resources/ }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Import complete/ })).toBeDefined()
    })

    // Assert — one archive per file, six resources, each pointing at one of the
    // two fresh archives.
    const archiveIds = writes()
      .filter((write) => write.url.includes('/DocumentReference/'))
      .map((write) => idFromUrl(write.url))
    expect(new Set(archiveIds).size).toBe(2)
    const sources = writes()
      .filter(isResourceWrite)
      .map((write) => metaSourceOf(write.body))
    expect(sources).toHaveLength(6)
    for (const source of sources) {
      expect(archiveIds.map((id) => `DocumentReference/${id}`)).toContain(source)
    }
  })

  it('excludes an unchecked resource from the write set — the reviewer opt-out is honoured on the wire', async () => {
    // Arrange
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act — pick locally so the preview parses to 1 Patient + 2 Observations
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Ready to import/ })).toBeDefined()
    })
    // Untick one Observation before confirm — the confirm count drops to 2.
    const obsBoxes = screen.getAllByRole('checkbox', { name: /Include Observation/ })
    expect(obsBoxes.length).toBeGreaterThanOrEqual(2)
    const [first] = obsBoxes
    if (first === undefined) throw new Error('unreachable: obsBoxes has at least two entries')
    await userEvent.click(first)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Import 2 resources/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /Import 2 resources/ }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Import complete/ })).toBeDefined()
    })

    // Assert — only two resource writes on the wire (one Patient + one Observation),
    // the opted-out Observation never left the browser.
    expect(writes().filter(isResourceWrite)).toHaveLength(2)
  })

  it('writes an edited resource verbatim — the inline JSON edit is what reaches the wire', async () => {
    // Arrange
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act — pick locally so the preview parses to 1 Patient + 2 Observations
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Ready to import/ })).toBeDefined()
    })

    // Open the editor for the Patient row, add a `gender` field to the
    // parsed JSON (keeping the adopted id and resourceType), and Keep. The
    // adopted id lives in the textarea already, so read the current text
    // and edit in place rather than typing over it — an id change would be
    // refused (and would in any case not travel across resource adoption).
    const editButtons = screen.getAllByRole('button', { name: /Edit Patient/ })
    expect(editButtons.length).toBeGreaterThanOrEqual(1)
    const [editPatient] = editButtons
    if (editPatient === undefined) throw new Error('unreachable: no Patient edit button')
    await userEvent.click(editPatient)
    const textarea = await screen.findByLabelText<HTMLTextAreaElement>('Resource JSON')
    const originalParsed = Schema.decodeUnknownSync(
      Schema.Record({ key: Schema.String, value: Schema.Unknown })
    )(JSON.parse(textarea.value))
    const edited = { ...originalParsed, gender: 'female' }
    await userEvent.clear(textarea)
    await userEvent.click(textarea)
    await userEvent.paste(JSON.stringify(edited))
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }))
    await waitFor(() => {
      // The row now advertises its edit.
      expect(screen.getByText('Edited')).toBeDefined()
    })

    // Confirm — the edit rides through as the value the wire carries
    await userEvent.click(screen.getByRole('button', { name: /Import 3 resources/ }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Import complete/ })).toBeDefined()
    })

    // Assert — the Patient write body reflects the edit (gender: female),
    // not the parsed original from the HAR (no gender at all).
    const patientWrites = writes().filter((write) => write.url.includes('/Patient/'))
    expect(patientWrites).toHaveLength(1)
    const [patientWrite] = patientWrites
    if (patientWrite === undefined) throw new Error('unreachable: exactly one Patient write')
    const body: unknown = JSON.parse(patientWrite.body)
    expect(body).toMatchObject({ resourceType: 'Patient', gender: 'female' })
  })

  it('discards the preview with no writes when the user cancels', async () => {
    // Arrange
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Ready to import/ })).toBeDefined()
    })

    // Act — cancel
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    // Assert — back at the source picker, and nothing was written
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'File source' })).toBeDefined()
    })
    expect(writes()).toHaveLength(0)
  })
})

// Helpers

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

/**
 * A HAR the `fhir-r4` importer recognizes: a Patient read and an Observation
 * searchset off one server, built through `web-trace-core`'s own `emitHar` so it
 * is shaped exactly like a real capture. Previews to 1 Patient + 2 Observations.
 */
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
            searchsetOf(
              {
                resourceType: 'Observation',
                id: 'obs-1',
                status: 'final',
                code: { text: 'Weight' },
              },
              {
                resourceType: 'Observation',
                id: 'obs-2',
                status: 'final',
                code: { text: 'Height' },
              }
            )
          ),
          startedAtMillis: CAPTURE_FLOOR + 1000,
        }),
      ],
      { sessionId: 'test-session' }
    )
  )
  // `emitHar` writes `request.method: 'UNKNOWN'` (the capture side never
  // observed a verb); rewrite the wire so the FHIR pool's `verb: ['GET']`
  // matchers claim these entries, mirroring what a real capture that
  // observed the method would carry through.
).replaceAll('"method":"UNKNOWN"', '"method":"GET"')

/** A recognized-HAR `File`, for the OS-picker (`upload`) path. */
const harFile = (name: string): File =>
  new File([RECOGNIZED_HAR], name, { type: 'application/json' })

/** One request the stub server saw: method, url, and decoded body. */
interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body: string
}

/** The write requests recorded so far, in order. */
const writes = (): readonly RecordedRequest[] =>
  recorded.filter((request) => request.method === 'PUT' || request.method === 'POST')

/** Whether a write is a FHIR resource write (a Patient or Observation), not the archive. */
const isResourceWrite = (write: RecordedRequest): boolean =>
  write.url.includes('/Patient/') || write.url.includes('/Observation/')

/** The `meta.source` a written resource carries, decoded rather than read off `any`. */
const MetaSourceWire = Schema.Struct({ meta: Schema.Struct({ source: Schema.String }) })
const metaSourceOf = (body: string): string =>
  Schema.decodeUnknownSync(MetaSourceWire)(JSON.parse(body)).meta.source

/** The last path segment of a request URL — a resource's logical id on a PUT/GetById. */
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

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(status === 200 ? JSON.stringify(body) : '', {
    status,
    headers: { 'content-type': 'application/json' },
  })

const decodeBody = (body: HttpClientRequest.HttpClientRequest['body']): string =>
  body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : ''

/**
 * A stub transport that records every request and routes it: a `category` search
 * answers with the configured archives, a `DocumentReference/<id>` GET answers
 * with that archive, and every PUT echoes the written body back (or a 503 when
 * `failWrite` says so). One stateless rule per shape — enough to drive the whole
 * flow and read the write log back.
 */
const routingServer = (config: {
  readonly archives?: readonly {
    readonly id: string
    readonly fileName: string
    readonly harText: string
  }[]
  readonly failWrite?: (request: HttpClientRequest.HttpClientRequest) => boolean
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
      if (config.failWrite?.(request) === true) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(null, 503)))
      }
      // Echo the written wire back as a 200 so the client decodes it and succeeds.
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
