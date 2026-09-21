import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DICOM_SOURCE_FILE_CODE, DICOM_SYSTEM } from 'dicom-importer-core/source-file'
import { DateTime, Effect, Layer, Schema } from 'effect'
import type * as FhirR4React from 'fhir-r4-react'
import type { RunAuthed } from 'fhir-r4-react'
import { buildSmartRouterContext } from 'fhir-r4-react/smart'
import { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'har-importer-core/source-file'
import {
  LIFELABS_PDF_SOURCE_FILE_CODE,
  LIFELABS_SYSTEM,
} from 'lifelabs-pdf-importer-core/source-file'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { ServerSourceFileList } from './server-source-file-list.tsx'

/**
 * The uploaded-source-files list, driven over a stub `HttpClient`, exercising:
 *
 *   - a mixed searchset (a HAR and a LifeLabs PDF) both list under the
 *     format-neutral heading, each with a Preview and a Use-as-source
 *     action;
 *   - Preview opens the modal, fetches the source file contents through the
 *     row's format's `sourceFileFromDocumentReference`, and renders the
 *     bytes (a JSON archive as pretty-printed text, a PDF via an
 *     `<iframe>` at a `blob:` URL);
 *   - Use as source fetches the source file and calls `onPick` with the
 *     bytes + a `server` source.
 *
 * jsdom does not implement `<dialog>`, so the two methods `Dialog` calls
 * are patched per-test — same trick `resource-editor.test.tsx` uses.
 *
 * jsdom also does not implement `URL.createObjectURL`; the preview blob
 * plumbing calls it, so we install a synthetic implementation that hands
 * back a marker string. Nothing here asserts the URL loads.
 */

vi.mock('fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunAuthed }
})

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')

const restoreDialog = (
  key: 'showModal' | 'close',
  descriptor: PropertyDescriptor | undefined
): void => {
  if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, key)
  else Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
}

const SERVER_URL = 'http://127.0.0.1:8080/fhir-r4'
const ACCESS_TOKEN = 'tok-abc'
const HAR_TEXT = '{"log":{"version":"1.2","entries":[]}}'
const PDF_BYTES_TEXT = '%PDF-1.4\n'

let currentRunAuthed: RunAuthed
let sentRequests: HttpClientRequest.HttpClientRequest[] = []
let queryClient: QueryClient
let createdBlobs: Blob[] = []

beforeEach(() => {
  sentRequests = []
  createdBlobs = []
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(): void {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }

  // Synthetic object URL — the tests assert what got minted, not that
  // the URL loads. Spied so `vi.restoreAllMocks()` in afterEach reverts
  // both to their originals (or removes them if jsdom had none).
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    if (blob instanceof Blob) createdBlobs.push(blob)
    return `blob:mock/${createdBlobs.length}`
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.restoreAllMocks()
  restoreDialog('showModal', originalShowModal)
  restoreDialog('close', originalClose)
})

describe('ServerSourceFileList', () => {
  it('should list a HAR and a LifeLabs PDF archive together under the format-neutral heading', async () => {
    // Arrange — a mixed searchset carrying one of each format
    const uploadedAt = DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z'))
    serveArchives([
      harArchiveWire({ id: 'har-1', fileName: 'portal.har', uploadedAt }),
      lifelabsPdfArchiveWire({ id: 'pdf-1', fileName: 'report.pdf', uploadedAt }),
    ])
    render(<ServerSourceFileList onPick={() => undefined} />, { wrapper: withQueryClient })

    // Assert — the format-neutral heading and both rows land, each with a
    // Preview and a Use-as-source action bearing the file name
    expect(
      await screen.findByRole('heading', { name: 'Uploaded source files on the FHIR server' })
    ).toBeDefined()
    expect(await screen.findByText('portal.har')).toBeDefined()
    expect(screen.getByText('report.pdf')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Preview portal.har' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Use portal.har as source' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Preview report.pdf' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Use report.pdf as source' })).toBeDefined()
  })

  it('should read a HAR archive contents and render it as pretty-printed JSON when Preview is clicked', async () => {
    // Arrange
    const uploadedAt = DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z'))
    serveArchives([harArchiveWire({ id: 'har-1', fileName: 'portal.har', uploadedAt })])
    render(<ServerSourceFileList onPick={() => undefined} />, { wrapper: withQueryClient })
    await screen.findByRole('button', { name: 'Preview portal.har' })

    // Act — open the preview
    await userEvent.click(screen.getByRole('button', { name: 'Preview portal.har' }))

    // Assert — the fetch went out, the JSON body is pretty-printed inside
    // the modal, and a Download-raw link is available
    await waitFor(() => {
      expect(screen.getByTestId('preview-json')).toBeDefined()
    })
    // Two spaces of indentation is the pretty-print signal — JSON.stringify(
    //   parsed, null, 2)
    expect(screen.getByTestId('preview-json').textContent).toContain('  "log"')
    // The archive was fetched by id off the FHIR base
    const fetchRequest = sentRequests.find((request) =>
      request.url.includes('/DocumentReference/har-1')
    )
    expect(fetchRequest?.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(screen.getByTestId('preview-download')).toBeDefined()
  })

  it('should read a LifeLabs PDF and render it as an iframe at a blob URL when Preview is clicked', async () => {
    // Arrange
    const uploadedAt = DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z'))
    serveArchives([lifelabsPdfArchiveWire({ id: 'pdf-1', fileName: 'report.pdf', uploadedAt })])
    render(<ServerSourceFileList onPick={() => undefined} />, { wrapper: withQueryClient })
    await screen.findByRole('button', { name: 'Preview report.pdf' })

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Preview report.pdf' }))

    // Assert — an iframe pointing at the blob URL for the PDF bytes,
    // with a sandbox attribute and the same-file title
    const frame = await waitFor(() => screen.getByTestId('preview-pdf-frame'))
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('src')?.startsWith('blob:')).toBe(true)
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts')
    expect(frame.getAttribute('title')).toBe('Preview of report.pdf')
    // The blob was minted with the PDF content type
    expect(createdBlobs[0]?.type).toBe('application/pdf')
  })

  it('should pick the source file as a source when Use-as-source is clicked, fetching it by id', async () => {
    // Arrange
    const uploadedAt = DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z'))
    serveArchives([harArchiveWire({ id: 'har-1', fileName: 'portal.har', uploadedAt })])
    let picked:
      | { readonly fileName: string; readonly bytes: Uint8Array; readonly source: unknown }
      | undefined
    render(<ServerSourceFileList onPick={(one) => (picked = one)} />, { wrapper: withQueryClient })
    await screen.findByRole('button', { name: 'Use portal.har as source' })

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Use portal.har as source' }))

    // Assert — onPick fires with the source file bytes and a `server` source
    // pointing at the fetched DocumentReference
    await waitFor(() => {
      expect(picked !== undefined).toBe(true)
    })
    expect(picked?.fileName).toBe('portal.har')
    expect(new TextDecoder().decode(picked?.bytes ?? new Uint8Array())).toBe(HAR_TEXT)
    expect(picked?.source).toEqual({ _tag: 'server', reference: 'DocumentReference/har-1' })
  })

  it('should collapse the archives of one study under one heading, with the files still listed', async () => {
    // Arrange — three DICOM archives, two of them read into one ImagingStudy
    const uploadedAt = DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z'))
    serveArchives([
      dicomArchiveWire({ id: 'dcm-1', fileName: 'I1.dcm', uploadedAt, study: 'study-a' }),
      dicomArchiveWire({ id: 'dcm-2', fileName: 'I2.dcm', uploadedAt, study: 'study-a' }),
      dicomArchiveWire({ id: 'dcm-3', fileName: 'J1.dcm', uploadedAt, study: 'study-b' }),
    ])
    render(<ServerSourceFileList onPick={() => undefined} onPickUnit={() => undefined} />, {
      wrapper: withQueryClient,
    })

    // Assert — the two-file study is one heading over its two rows; the
    // lone archive of the other study is an ordinary row with no heading
    expect(await screen.findByText('Study · 2 files')).toBeDefined()
    expect(screen.queryByText('Study · 1 files')).toBeNull()
    expect(screen.getByRole('button', { name: 'Use I1.dcm as source' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Use I2.dcm as source' })).toBeDefined()
    expect(screen.getByText('J1.dcm')).toBeDefined()
  })

  it('should pick every file of a study when Use-all-as-source is clicked', async () => {
    // Arrange
    const uploadedAt = DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z'))
    serveArchives([
      dicomArchiveWire({ id: 'dcm-1', fileName: 'I1.dcm', uploadedAt, study: 'study-a' }),
      dicomArchiveWire({ id: 'dcm-2', fileName: 'I2.dcm', uploadedAt, study: 'study-a' }),
    ])
    let picked: readonly { readonly fileName: string; readonly source: unknown }[] | undefined
    render(
      <ServerSourceFileList
        onPick={() => undefined}
        onPickUnit={(all) => {
          picked = all
        }}
      />,
      { wrapper: withQueryClient }
    )
    const useAll = await screen.findByRole('button', {
      name: 'Use all 2 files of this study as source',
    })

    // Act
    await userEvent.click(useAll)

    // Assert — one pick carrying both files, each a `server` source, so the
    // decode downstream sees the whole study rather than two one-file ones
    await waitFor(() => {
      expect(picked !== undefined).toBe(true)
    })
    expect(picked?.map((one) => one.fileName)).toEqual(['I1.dcm', 'I2.dcm'])
    expect(picked?.map((one) => one.source)).toEqual([
      { _tag: 'server', reference: 'DocumentReference/dcm-1' },
      { _tag: 'server', reference: 'DocumentReference/dcm-2' },
    ])
  })

  it('should offer no whole-study pick to a host that takes one file at a time', async () => {
    // The anonymizer's `serverSource` slot: it still sees the study grouped,
    // but has nowhere to put a two-file pick, so the action is absent.
    const uploadedAt = DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z'))
    serveArchives([
      dicomArchiveWire({ id: 'dcm-1', fileName: 'I1.dcm', uploadedAt, study: 'study-a' }),
      dicomArchiveWire({ id: 'dcm-2', fileName: 'I2.dcm', uploadedAt, study: 'study-a' }),
    ])
    render(<ServerSourceFileList onPick={() => undefined} />, { wrapper: withQueryClient })

    expect(await screen.findByText('Study · 2 files')).toBeDefined()
    expect(screen.queryByRole('button', { name: /Use all/u })).toBeNull()
  })

  it('should render the empty state format-neutrally when the server has no source files', async () => {
    // Arrange
    serveArchives([])
    render(<ServerSourceFileList onPick={() => undefined} />, { wrapper: withQueryClient })

    // Assert
    expect(
      await screen.findByText('No source files have been uploaded to the FHIR server.')
    ).toBeDefined()
  })
})

// Helpers

const base64 = Schema.encodeSync(Schema.StringFromBase64)

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
    type: { coding },
    category: [{ coding }],
    date: iso,
    content: [
      {
        attachment: {
          contentType: 'application/json',
          data: base64(HAR_TEXT),
          title: fields.fileName,
          creation: iso,
        },
      },
    ],
  }
}

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
    type: { coding },
    category: [{ coding }],
    date: iso,
    content: [
      {
        attachment: {
          contentType: 'application/pdf',
          data: base64(PDF_BYTES_TEXT),
          title: fields.fileName,
          creation: iso,
        },
      },
    ],
  }
}

const dicomArchiveWire = (fields: {
  readonly id: string
  readonly fileName: string
  readonly uploadedAt: DateTime.Utc
  readonly study: string
}): unknown => {
  const iso = DateTime.formatIso(fields.uploadedAt)
  const coding = [{ system: DICOM_SYSTEM, code: DICOM_SOURCE_FILE_CODE }]
  return {
    resourceType: 'DocumentReference',
    id: fields.id,
    status: 'current',
    type: { coding },
    category: [{ coding }],
    date: iso,
    subject: { reference: 'Patient/p-1' },
    context: { related: [{ reference: `ImagingStudy/${fields.study}` }] },
    content: [
      {
        attachment: {
          contentType: 'application/dicom',
          data: base64('DICM stand-in'),
          title: fields.fileName,
          creation: iso,
        },
      },
    ],
  }
}

const searchset = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [],
})

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/**
 * Serves the source file search and the per-id GetById off one rule: a request
 * with a `category` param is the search (answers the whole `resources`
 * array as one page), anything else is a GetById (find the source file whose
 * id matches the last URL path segment).
 */
const idOf = (resource: unknown): string | undefined => {
  if (typeof resource !== 'object' || resource === null) return undefined
  const value: unknown = Reflect.get(resource, 'id')
  return typeof value === 'string' ? value : undefined
}

const serveArchives = (resources: readonly unknown[]): void => {
  const byId = new Map<string, unknown>()
  for (const resource of resources) {
    const id = idOf(resource)
    if (id !== undefined) byId.set(id, resource)
  }
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      sentRequests.push(request)
      const params = Object.fromEntries(request.urlParams)
      if (params['category'] !== undefined) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, jsonResponse(searchset(resources)))
        )
      }
      const path = request.url.split('?')[0] ?? request.url
      const id = path.split('/').at(-1) ?? ''
      const wire = byId.get(id)
      if (wire === undefined) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))
        )
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(wire)))
    })
  )
  currentRunAuthed = buildSmartRouterContext(
    { serverUrl: SERVER_URL, accessToken: ACCESS_TOKEN },
    httpLayer
  ).runAuthed
}

const withQueryClient = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)
