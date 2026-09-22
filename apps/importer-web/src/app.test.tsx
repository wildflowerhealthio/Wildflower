import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DateTime, Effect, Layer, Schema } from 'effect'
import { buildSmartRouterContext } from 'fhir-r4-react/smart'
import { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'har-importer-core/source-file'
import { emitHar, HarFromJson } from 'http-archive'
import { COMPLETE_HEADING, PREVIEW_HEADING } from 'importer-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { TraceBody } from 'web-trace-core'
import { CAPTURE_FLOOR, jsonBody, traceExchange } from 'web-trace-core/test-helpers'

import { ImporterApp } from './app.tsx'

/**
 * The app's own wiring, end to end: its router context satisfies
 * `importer-react`'s `useRunAuthed`, its HTTP layer addresses the FHIR server
 * the SMART handshake named and carries the granted token, and the screen it
 * mounts walks all the way from a picked HAR to a completed import.
 *
 * Only the transport is a stub. Everything above it — the real
 * `buildSmartRouterContext`, the router, the queries, the typed FHIR client, the
 * HAR parser and the source file codec — is the production path, so a break in any
 * of them fails here rather than only on a device.
 *
 * The two assertions this app owns, which no test one layer down can make:
 *
 * - **every request the flow issues is addressed to the FHIR base and carries
 *   the bearer token** — the slice's own test replaces the router seam, so the
 *   prefixing and the `Authorization` header only ever go on the wire here;
 * - **the write scopes in `config.ts` are the ones the flow actually needs** —
 *   the recorded write log names exactly the resource types that string (and the
 *   gatekeeper seed beside it) allows.
 *
 * The opt-in seam itself — zero writes to reach a preview, source file before
 * resources, `meta.source` on each write — is `importer-react`'s
 * `importer-screen.test.tsx`. What is re-asserted here is only the ordering that
 * the app's own transport makes observable.
 */

const SERVER_URL = 'http://127.0.0.1:8080/fhir-r4'
const ACCESS_TOKEN = 'tok-abc'

/** Every request the stub transport saw, in order. */
let recorded: RecordedRequest[] = []

/**
 * jsdom's `TextEncoder` hands back a `Uint8Array` from a realm the source file codec's
 * `Uint8ArrayFromSelf` schema rejects on `instanceof` — a purely jsdom artifact,
 * since a browser has one realm and a real capture's bytes always satisfy the
 * check. Re-wrapping the encoder's output through the ambient `Uint8Array`
 * reproduces the single-realm behaviour the confirm step's local-upload encode
 * has in a browser (the same workaround `importer-screen.test.tsx` carries).
 */
const AmbientTextEncoder = globalThis.TextEncoder
class RealmSafeTextEncoder extends AmbientTextEncoder {
  override encode(input?: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(super.encode(input))
  }
}

beforeEach(() => {
  recorded = []
  vi.stubGlobal('TextEncoder', RealmSafeTextEncoder)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ImporterApp', () => {
  it('should import a picked source file end to end, writing nothing before the confirm', async () => {
    // Arrange — nothing on the server yet; the HAR comes off the local disk
    mount({})

    // Act — pick a recognized HAR through the OS picker
    await userEvent.upload(
      await screen.findByLabelText('Import file'),
      harFile('portal-session.har')
    )

    // Assert — the preview is up and NOT ONE write went out to reach it
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    })
    expect(writes()).toHaveLength(0)

    // Act — confirm (one Patient + two Observations + the source-file source file)
    await userEvent.click(screen.getByRole('button', { name: /Import 4 resources/ }))

    // Assert — the import completes, and the source file create lands before the
    // first resource write, so every written resource can name it
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: COMPLETE_HEADING })).toBeDefined()
    })
    const sourceFileCreate = writes().findIndex((write) =>
      write.url.includes('/DocumentReference/')
    )
    const firstResource = writes().findIndex(isResourceWrite)
    expect(sourceFileCreate).toBeGreaterThanOrEqual(0)
    expect(firstResource).toBeGreaterThan(sourceFileCreate)
  })

  // The two halves that a self-hosted origin makes non-obvious: the app is not
  // served by the API, so a relative path would resolve against the app's own
  // port, and the API's cookie is not sent cross-origin so the token is the
  // credential. This app writes, so both halves have to hold for writes too —
  // an unaddressed PUT is not a failed read, it is a record written somewhere
  // else.
  it('should address every read and write to the FHIR server named by the handshake, with the granted token', async () => {
    // Arrange & Act — the whole flow, so the log holds reads and writes alike
    await importOneSourceFile()

    // Assert — the source list, the source file create and every resource write
    expect(recorded.length).toBeGreaterThan(0)
    for (const request of recorded) {
      expect(request.url.startsWith(`${SERVER_URL}/`)).toBe(true)
      expect(request.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    }
    expect(recorded.some((request) => request.method === 'GET')).toBe(true)
  })

  // `src/config.ts` asks for `DocumentReference`, `Patient` and `Observation`
  // writes and nothing else, and the gatekeeper seed allows exactly that set. A
  // flow that wrote a fourth resource type would be refused the scope at
  // authorize time on a real device; here it surfaces as a resource type the
  // requested set does not name.
  it('should write only the resource types its requested scopes cover', async () => {
    // Arrange & Act
    await importOneSourceFile()

    // Assert
    const written = new Set(writes().map((write) => resourceTypeOf(write.url)))
    expect([...written].toSorted()).toEqual(['DocumentReference', 'Observation', 'Patient'])
  })

  it('should read a server-held source file back off the FHIR server and re-file it under one source file', async () => {
    // Arrange — one source file already on the server, carrying the recognized HAR
    mount({ sourceFiles: [{ id: 'archive-1', fileName: 'server-session.har' }] })

    // Act — select it in the server list, pick it as the batch's source,
    // then confirm
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Select server-session.har' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Use selected as source' }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /Import 4 resources/ }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: COMPLETE_HEADING })).toBeDefined()
    })

    // Assert — the source file was fetched by id off the FHIR base, with the token
    const byId = recorded.find(
      (request) => request.method === 'GET' && request.url.includes('/DocumentReference/archive-1')
    )
    expect(byId?.url.startsWith(`${SERVER_URL}/`)).toBe(true)
    expect(byId?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    // Every pick is stored, and the id is a hash of the bytes and the name —
    // so a file re-picked off the server is re-filed under exactly one source file,
    // an upsert rather than a growing pile of copies.
    const sourceFileWrites = writes().filter((write) => write.url.includes('/DocumentReference/'))
    expect(sourceFileWrites).toHaveLength(1)
  })

  it('should render the app shell around the slice screen it mounts, on the Import tab by default', async () => {
    // Arrange / Act
    mount({})

    // Assert — the app owns the title, the Import|Anonymize toggle (pressed on
    // Import by default) and the subtitle for that tab; the picker below it is
    // the slice's.
    expect(await screen.findByRole('heading', { name: 'Importer', level: 1 })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Import' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Anonymize' }).getAttribute('aria-pressed')).toBe(
      'false'
    )
    expect(screen.getByText('Import FHIR records from a captured browsing session.')).toBeDefined()
    expect(screen.getByRole('region', { name: 'File source' })).toBeDefined()
    // Nothing from the anonymize surface mounts on the Import tab.
    expect(screen.queryByRole('region', { name: 'Anonymize' })).toBeNull()
  })

  it('should mount the Anonymize surface — and unmount the Import one — when the toggle flips', async () => {
    // Arrange
    mount({})
    await screen.findByRole('heading', { name: 'Importer', level: 1 })

    // Act — flip to Anonymize
    await userEvent.click(screen.getByRole('button', { name: 'Anonymize' }))

    // Assert — the subtitle updates, the anonymize picker is up, and the
    // ImporterScreen's `<div class="screen">` is no longer in the tree (the
    // identifying anchor is the tab-specific subtitle).
    expect(
      await screen.findByText(
        'Replace every value in a capture with a pseudonym so its shape can be shared.'
      )
    ).toBeDefined()
    expect(screen.getByRole('button', { name: 'Anonymize' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(screen.getByRole('button', { name: 'Import' }).getAttribute('aria-pressed')).toBe(
      'false'
    )
    expect(screen.queryByText('Import FHIR records from a captured browsing session.')).toBeNull()

    // Flip back — the Import subtitle returns, confirming a re-mount fresh at
    // the picker (the screen owns its own read state).
    await userEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(
      await screen.findByText('Import FHIR records from a captured browsing session.')
    ).toBeDefined()
    expect(
      screen.queryByText(
        'Replace every value in a capture with a pseudonym so its shape can be shared.'
      )
    ).toBeNull()
  })

  it('should reach an anonymize download from a picked HAR with zero writes on the wire', async () => {
    // Arrange
    mount({})
    await userEvent.click(await screen.findByRole('button', { name: 'Anonymize' }))

    // Act — pick a recognized HAR through the Anonymize tab's own picker (the
    // anonymizer shell's format-blind input, not the importer's HAR picker)
    await userEvent.upload(
      await screen.findByLabelText('File to anonymize'),
      harFile('portal-session.har')
    )

    // Assert — the anonymize panel is up and offers the download; the whole
    // preview + settings + blob download flow is client-side, so NOT ONE write
    // went out to reach it.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Download anonymized HAR' })).toBeDefined()
    })
    expect(writes()).toHaveLength(0)
  })
})

// Helpers

/** One request the stub server saw: method, url, bearer header, and decoded body. */
interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly authorization: string | undefined
  readonly body: string
}

/** A source file the stub server holds, keyed by the id the flow addresses it at. */
interface ServerSourceFile {
  readonly id: string
  readonly fileName: string
}

/** The write requests recorded so far, in order. */
const writes = (): readonly RecordedRequest[] =>
  recorded.filter((request) => request.method === 'PUT' || request.method === 'POST')

/** Whether a write is a FHIR resource write (a Patient or Observation), not the source file. */
const isResourceWrite = (write: RecordedRequest): boolean =>
  write.url.includes('/Patient/') || write.url.includes('/Observation/')

/** The last path segment of a request URL — a resource's logical id on a PUT / GET-by-id. */
const idFromUrl = (url: string): string => {
  const path = url.split('?')[0] ?? url
  const segments = path.split('/')
  return segments[segments.length - 1] ?? ''
}

/** The resource type a `…/<Type>/<id>` write URL addresses. */
const resourceTypeOf = (url: string): string => {
  const segments = (url.split('?')[0] ?? url).split('/')
  return segments[segments.length - 2] ?? ''
}

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
 * A HAR the `fhir-r4` collector recognizes: a Patient read and an Observation
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

/** Text as base64, the way the source file codec stores the file's bytes. */
const base64 = Schema.encodeSync(Schema.StringFromBase64)

/** One source file `DocumentReference` wire, decodable by the codec and rowable by the list. */
const sourceFileWire = (sourceFile: ServerSourceFile): unknown => {
  const coding = [{ system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE }]
  const iso = DateTime.formatIso(DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z')))
  return {
    resourceType: 'DocumentReference',
    id: sourceFile.id,
    status: 'current',
    type: { coding },
    category: [{ coding }],
    date: iso,
    content: [
      {
        attachment: {
          contentType: 'application/json',
          data: base64(RECOGNIZED_HAR),
          title: sourceFile.fileName,
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

/**
 * A stub transport that records every request — including the header and URL the
 * app's own layer put on it — and routes it: a `category` search answers with the
 * configured source files, a `DocumentReference/<id>` GET answers with that source file,
 * and every write echoes the written body back. One stateless rule per shape,
 * which is enough to drive the whole flow and read the log back.
 */
const recordingServer = (
  sourceFiles: readonly ServerSourceFile[]
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const body = decodeBody(request.body)
      const authorization = request.headers['authorization']

      // A `POST /` at the FHIR base with a Bundle body is `fhir-r4`'s
      // bundle-submit (a batch of PUT entries from persistBatchBundle, or a
      // batch of GET entries from classifyAgainstServer). Unwrap: record each
      // entry as its own request, mirror the batch-response. This keeps
      // `writes()` / `isResourceWrite` seeing one recorded request per
      // resource operation.
      if (
        request.method === 'POST' &&
        (request.url === `${SERVER_URL}/` || request.url === SERVER_URL)
      ) {
        const parsed = safeParseBundle(body)
        if (parsed !== undefined) {
          const entries = parsed.entry ?? []
          const responseEntries: unknown[] = []
          for (const entry of entries) {
            const entryReq = entry.request
            if (entryReq === undefined) {
              responseEntries.push({ response: { status: '400 Bad Request' } })
              continue
            }
            const entryUrl = `${SERVER_URL}/${entryReq.url}`
            const entryBody = entry.resource === undefined ? '' : JSON.stringify(entry.resource)
            recorded.push({
              method: entryReq.method,
              url: entryUrl,
              authorization,
              body: entryBody,
            })
            if (entryReq.method === 'GET') {
              responseEntries.push({ response: { status: '404 Not Found' } })
              continue
            }
            responseEntries.push({
              response: { status: '200 OK' },
              ...(entry.resource !== undefined ? { resource: entry.resource } : {}),
            })
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              jsonResponse({
                resourceType: 'Bundle',
                type: 'batch-response',
                entry: responseEntries,
              })
            )
          )
        }
      }

      recorded.push({
        method: request.method,
        url: request.url,
        authorization,
        body,
      })
      const params = Object.fromEntries(request.urlParams)
      if (request.method === 'GET' && params['category'] !== undefined) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            jsonResponse(searchsetOf(...sourceFiles.map((one) => sourceFileWire(one))))
          )
        )
      }
      if (request.method === 'GET') {
        const id = idFromUrl(request.url)
        const sourceFile = sourceFiles.find((one) => one.id === id) ?? { id, fileName: `${id}.har` }
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, jsonResponse(sourceFileWire(sourceFile)))
        )
      }
      // Echo the written wire back as a 200 so the client decodes it and succeeds.
      const written: unknown = body === '' ? {} : JSON.parse(body)
      return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(written)))
    })
  )

/** Minimal shape read from the request body of a `POST /` batch bundle. */
interface RecordedBundleShape {
  readonly entry?: readonly {
    readonly request?: { readonly method: string; readonly url: string }
    readonly resource?: unknown
  }[]
}

/**
 * Best-effort parse of a `POST /` body as a batch Bundle — `undefined` when
 * the body isn't a bundle so a non-bundle POST at `/` falls through.
 */
const safeParseBundle = (body: string): RecordedBundleShape | undefined => {
  if (body === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as { readonly resourceType?: unknown }
  if (record.resourceType !== 'Bundle') return undefined
  return parsed
}

/**
 * Mount the app through the **real** `buildSmartRouterContext`, so the URL
 * prefixing and the bearer header under test are the production ones.
 */
const mount = (config: { readonly sourceFiles?: readonly ServerSourceFile[] }): void => {
  const context = buildSmartRouterContext(
    { serverUrl: SERVER_URL, accessToken: ACCESS_TOKEN },
    recordingServer(config.sourceFiles ?? [])
  )
  render(<ImporterApp context={context} />)
}

/** Drive the local-pick flow from an empty server all the way to a completed import. */
const importOneSourceFile = async (): Promise<void> => {
  mount({})
  await userEvent.upload(await screen.findByLabelText('Import file'), harFile('portal-session.har'))
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
  })
  // One Patient + two Observations + the source-file source file (a local pick
  // creates its own DocumentReference; a server-sourced HAR reuses the existing
  // one and previews only the three extracted resources).
  await userEvent.click(screen.getByRole('button', { name: /Import 4 resources/ }))
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: COMPLETE_HEADING })).toBeDefined()
  })
}
