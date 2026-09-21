// oxlint-disable import/max-dependencies
import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DICOM_SOURCE_FILE_CODE, DICOM_SYSTEM } from 'dicom-importer-core/source-file'
import { DateTime, Effect, Layer, Schema } from 'effect'
import type * as FhirR4React from 'fhir-r4-react'
import { buildSmartRouterContext } from 'fhir-r4-react/smart'
import { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'har-importer-core/source-file'
import type { FormatDetector } from 'importer-fundamentals'
import {
  LIFELABS_PDF_SOURCE_FILE_CODE,
  LIFELABS_SYSTEM,
} from 'lifelabs-pdf-importer-core/source-file'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { SOURCE_FILES_CATEGORY_TOKEN } from '../queries/source-files.ts'
import { REJECTION_MESSAGE } from './local-file.ts'
import { SourcePicker } from './source-picker.tsx'

/**
 * A minimal HAR detector stub — extension `.har` or JSON-object shape.
 * Matches `har-importer-core`'s `detectHar` semantics; kept inline here so
 * the picker test does not depend on the concrete binding.
 */
const harDetector: FormatDetector.Type = {
  format: 'har',
  detect: (bytes, name) => name.toLowerCase().endsWith('.har') || bytes[0] === 0x7b,
}
const testDetectors: readonly FormatDetector.Type[] = [harDetector]

/**
 * The whole picker, driven over the real
 * query → runner → FHIR-client → `HttpClient` path with a stub transport. Only
 * the router seam (`useRunAuthed`) is replaced, the `documents-panel.test.tsx`
 * pattern, and the runner carries a bearer token via `fhir-r4-react/smart` so the
 * search's URL and its `Authorization` header can both be asserted.
 *
 * The load-bearing observation is convergence: a file dropped, a file chosen, and
 * a server archive selected all reach `onPick` with the same HAR text — the
 * local two identically, the server one under a `server` source that names the
 * stored archive.
 */

vi.mock('fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): FhirR4React.RunAuthed => currentRunAuthed }
})

const SERVER_URL = 'http://127.0.0.1:8080/fhir-r4'
const ACCESS_TOKEN = 'tok-abc'

/** A minimal but complete HAR 1.2 archive, shared by every source in a test. */
const VALID_HAR = JSON.stringify({
  log: {
    version: '1.2',
    creator: { name: 'WebInspector', version: '537.36' },
    entries: [
      {
        startedDateTime: '2026-08-13T10:00:00.000Z',
        request: { method: 'GET', url: 'https://portal.example.org/api/v2/patients' },
        response: { status: 200, content: { size: 0, mimeType: 'application/json' } },
      },
    ],
  },
})

let currentRunAuthed: FhirR4React.RunAuthed
let sentRequests: HttpClientRequest.HttpClientRequest[] = []
let queryClient: QueryClient

beforeEach(() => {
  sentRequests = []
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.restoreAllMocks()
})

describe('SourcePicker', () => {
  it('should reach the same HAR text from a dropped file, a chosen file, and a server archive', async () => {
    // Arrange — one archive on the server, carrying the same HAR the local file does
    serveArchives({
      pages: [{ archives: [{ id: 'archive-1', fileName: 'portal-session.har' }] }],
      harTextById: { 'archive-1': VALID_HAR },
    })
    const picks: Array<{ fileName: string; bytes: Uint8Array; source: unknown }> = []
    render(<SourcePicker detectors={testDetectors} onPick={(chosen) => picks.push(...chosen)} />, {
      wrapper: withQueryClient,
    })
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Select portal-session.har' })).toBeDefined()
    })

    // Act 1 — chosen through the OS picker
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
    // Act 2 — dropped on the zone via a synthesized DataTransfer
    fireEvent.drop(zone(), { dataTransfer: dataTransferOf(harFile('portal-session.har')) })
    await waitFor(() => {
      expect(picks).toHaveLength(2)
    })
    // Act 3 — selected from the server list and picked as the batch's source
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select portal-session.har' }))
    await userEvent.click(screen.getByRole('button', { name: 'Use selected as source' }))
    await waitFor(() => {
      expect(picks).toHaveLength(3)
    })

    // Assert — every path carried the same HAR bytes; the two local picks are identical
    const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
    expect(picks.map((pick) => decode(pick.bytes))).toEqual([VALID_HAR, VALID_HAR, VALID_HAR])
    expect(picks[0]?.fileName).toBe('portal-session.har')
    expect(picks[0]?.source).toEqual({ _tag: 'local' })
    expect(decode(picks[1]?.bytes ?? new Uint8Array())).toBe(VALID_HAR)
    expect(picks[1]?.source).toEqual({ _tag: 'local' })
    expect(picks[2]?.source).toEqual({ _tag: 'server', reference: 'DocumentReference/archive-1' })
  })

  it('should list server archives by title and date, and read the selected one over an authed search', async () => {
    // Arrange
    const uploadedAt = '2026-08-13'
    serveArchives({
      pages: [
        { archives: [{ id: 'archive-1', fileName: 'portal-session.har', date: uploadedAt }] },
      ],
      harTextById: { 'archive-1': VALID_HAR },
    })
    let picked: { bytes: Uint8Array; source: unknown } | undefined
    render(<SourcePicker detectors={testDetectors} onPick={(chosen) => (picked = chosen[0])} />, {
      wrapper: withQueryClient,
    })

    // Assert — the row shows the title and the upload date
    await waitFor(() => {
      expect(screen.getByText('portal-session.har')).toBeDefined()
    })
    expect(screen.getByText(uploadedAt)).toBeDefined()

    // …the search went out filtered by the comma-joined archive category
    // covering every registered format, sized, and authed
    expect(paramsOf(0)['category']).toBe(SOURCE_FILES_CATEGORY_TOKEN)
    expect(SOURCE_FILES_CATEGORY_TOKEN).toBe(
      `${WEB_TRACE_CODE_SYSTEM}|${HAR_ARCHIVE_CODE},${LIFELABS_SYSTEM}|${LIFELABS_PDF_SOURCE_FILE_CODE},${DICOM_SYSTEM}|${DICOM_SOURCE_FILE_CODE}`
    )
    expect(paramsOf(0)['_count']).toBe('50')
    expect(sentRequests[0]?.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`)

    // Act — select the row and pick it
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select portal-session.har' }))
    await userEvent.click(screen.getByRole('button', { name: 'Use selected as source' }))

    // Assert — the chosen archive is fetched and returned as bytes
    await waitFor(() => {
      expect(picked !== undefined).toBe(true)
    })
    expect(new TextDecoder().decode(picked?.bytes ?? new Uint8Array())).toBe(VALID_HAR)
    expect(picked?.source).toEqual({ _tag: 'server', reference: 'DocumentReference/archive-1' })
    // The fetch was a second, authed request
    expect(sentRequests[1]?.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`)
  })

  it('should page the server list with the cursor from the bundle next link', async () => {
    // Arrange — page one carries a next cursor, page two does not
    serveArchives({
      pages: [
        { archives: [{ id: 'archive-1', fileName: 'first.har' }], nextCursor: 'cursor-2' },
        { archives: [{ id: 'archive-2', fileName: 'second.har' }] },
      ],
      harTextById: {},
    })
    render(<SourcePicker detectors={testDetectors} onPick={() => undefined} />, {
      wrapper: withQueryClient,
    })
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Select first.har' })).toBeDefined()
    })

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Show more source files' }))

    // Assert — the second search carried the cursor, and both pages are listed
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Select second.har' })).toBeDefined()
    })
    expect(paramsOf(0)['_pageToken']).toBeUndefined()
    expect(paramsOf(1)['_pageToken']).toBe('cursor-2')
  })

  it('should expose the drop zone as a labeled button and the file input as a named control', () => {
    // Arrange
    serveArchives({ pages: [{ archives: [] }], harTextById: {} })
    render(<SourcePicker detectors={testDetectors} onPick={() => undefined} />, {
      wrapper: withQueryClient,
    })

    // Assert — a real button (so keyboard-activatable) with an accessible name,
    // inside a labeled region, and a named file input drop is an enhancement over
    const region = screen.getByRole('region', { name: 'File source' })
    const button = screen.getByRole('button', { name: /Choose files, or drop them here/ })
    expect(region).toBeDefined()
    expect(button.tagName).toBe('BUTTON')
    expect(screen.getByLabelText('Import file')).toBeDefined()
  })

  it('should reject a dropped file that is not a HAR at the picker, without calling onPick', async () => {
    // Arrange
    serveArchives({ pages: [{ archives: [] }], harTextById: {} })
    const picks: unknown[] = []
    render(<SourcePicker detectors={testDetectors} onPick={(chosen) => picks.push(...chosen)} />, {
      wrapper: withQueryClient,
    })

    // Act — a text file, not a HAR
    fireEvent.drop(zone(), {
      dataTransfer: dataTransferOf(new File(['not a har'], 'notes.txt', { type: 'text/plain' })),
    })

    // Assert — the failure lands here, next to the control, and nothing is picked.
    // `exact: false`: the notice now leads with REJECTION_MESSAGE and appends the
    // parser's own detail line, so the lead is a substring rather than the whole.
    await waitFor(() => {
      expect(screen.getByText(REJECTION_MESSAGE, { exact: false })).toBeDefined()
    })
    expect(screen.getByRole('alert')).toBeDefined()
    expect(picks).toHaveLength(0)
  })

  it('should pick several chosen files at once as one batch', async () => {
    // Arrange
    serveArchives({ pages: [{ archives: [] }], harTextById: {} })
    const calls: string[][] = []
    render(
      <SourcePicker
        detectors={testDetectors}
        onPick={(chosen) => calls.push(chosen.map((one) => one.fileName))}
      />,
      { wrapper: withQueryClient }
    )

    // Act — two HAR files chosen in one dialog
    await userEvent.upload(screen.getByLabelText('Import file'), [
      harFile('one.har'),
      harFile('two.har'),
    ])

    // Assert — a single onPick carrying both files, in order
    await waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    expect(calls[0]).toEqual(['one.har', 'two.har'])
  })

  it('should pick a whole folder as one batch, through a directory input', async () => {
    // Arrange — a study arrives as a directory, not as files chosen by hand
    serveArchives({ pages: [{ archives: [] }], harTextById: {} })
    const calls: string[][] = []
    render(
      <SourcePicker
        detectors={testDetectors}
        onPick={(chosen) => calls.push(chosen.map((one) => one.fileName))}
      />,
      { wrapper: withQueryClient }
    )

    // The input the folder button opens is a directory input from its first
    // paint — a file input would silently pick one file at a time.
    const folderInput = screen.getByLabelText('Import folder')
    expect(folderInput.hasAttribute('webkitdirectory')).toBe(true)

    // Act
    await userEvent.upload(folderInput, [harFile('one.har'), harFile('two.har')])

    // Assert — one batch, exactly as a multi-file pick produces
    await waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    expect(calls[0]).toEqual(['one.har', 'two.har'])
  })

  it('should hand a caller every server row it selected as one pick', async () => {
    serveArchives({
      pages: [
        {
          archives: [
            { id: 'archive-1', fileName: 'first.har' },
            { id: 'archive-2', fileName: 'second.har' },
          ],
        },
      ],
      harTextById: { 'archive-1': VALID_HAR, 'archive-2': VALID_HAR },
    })
    const calls: string[][] = []
    render(
      <SourcePicker
        detectors={testDetectors}
        onPick={(chosen) => calls.push(chosen.map((one) => one.fileName))}
      />,
      { wrapper: withQueryClient }
    )
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Select first.har' })).toBeDefined()
    })

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select first.har' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select second.har' }))
    await userEvent.click(screen.getByRole('button', { name: 'Use selected as source' }))

    // One pick carrying both rows — what lets a re-picked study decode as one.
    await waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    // The names are the fetched archives' own — the list's rows are titled by
    // the search result, the pick by what the fetch read back.
    expect(calls[0]).toEqual(['archive-1.har', 'archive-2.har'])
  })

  it('should hand a one-at-a-time caller the server row it used, as a list of one', async () => {
    serveArchives({
      pages: [{ archives: [{ id: 'archive-1', fileName: 'portal-session.har' }] }],
      harTextById: { 'archive-1': VALID_HAR },
    })
    const calls: string[][] = []
    render(
      <SourcePicker
        detectors={testDetectors}
        mode="single"
        onPick={(chosen) => calls.push(chosen.map((one) => one.fileName))}
      />,
      { wrapper: withQueryClient }
    )
    const use = await screen.findByRole('button', { name: 'Use portal-session.har as source' })

    await userEvent.click(use)

    await waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    expect(calls[0]).toEqual(['archive-1.har'])
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('should offer no folder pick to a caller that consumes one file at a time', () => {
    serveArchives({ pages: [{ archives: [] }], harTextById: {} })
    render(<SourcePicker detectors={testDetectors} onPick={() => undefined} mode="single" />, {
      wrapper: withQueryClient,
    })
    expect(screen.queryByLabelText('Import folder')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Choose a folder' })).toBeNull()
  })

  it('should pick the valid files in a mixed drop and name the ones that were not HARs', async () => {
    // Arrange
    serveArchives({ pages: [{ archives: [] }], harTextById: {} })
    const picks: string[] = []
    render(
      <SourcePicker
        detectors={testDetectors}
        onPick={(chosen) => picks.push(...chosen.map((one) => one.fileName))}
      />,
      { wrapper: withQueryClient }
    )

    // Act — one real HAR and one text file, dropped together
    fireEvent.drop(zone(), {
      dataTransfer: dataTransferOf(
        harFile('good.har'),
        new File(['not a har'], 'notes.txt', { type: 'text/plain' })
      ),
    })

    // Assert — the valid file is picked; the rejected one is named in the notice
    await waitFor(() => {
      expect(picks).toEqual(['good.har'])
    })
    expect(screen.getByRole('alert').textContent).toMatch(/notes\.txt/)
  })
})

// Helpers

/** Text as base64, the way the archive codec stores the file's bytes. */
const base64 = Schema.encodeSync(Schema.StringFromBase64)

/** A real HAR `File`, for the OS-picker (`upload`) and drop paths. */
const harFile = (name: string): File => new File([VALID_HAR], name, { type: 'application/json' })

/** The drop-and-pick zone button. */
const zone = (): HTMLElement =>
  screen.getByRole('button', { name: /Choose files, or drop them here/ })

/**
 * A `DataTransfer`-like carrying one or more files, enough for a synthesized
 * `drop`.
 *
 * @remarks
 * jsdom's `DataTransfer` does not populate `files` from `items.add`, so the drop
 * handler is fed a plain object whose `files` is the array `Array.from` reads —
 * a real drop of several files reaches the batch path the same way.
 */
const dataTransferOf = (...files: readonly File[]): { readonly files: readonly File[] } => ({
  files,
})

/** One archive `DocumentReference` wire, decodable and rowable. */
const archiveWire = (fields: {
  readonly id: string
  readonly fileName: string
  readonly date?: string
  readonly harText?: string
}): unknown => {
  const coding = [{ system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE }]
  const iso = DateTime.formatIso(
    DateTime.unsafeFromDate(new Date(`${fields.date ?? '2026-08-13'}T10:00:00.000Z`))
  )
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

/** The last path segment of a request URL — a resource's logical id on a GetById. */
const idFromUrl = (url: string): string => {
  const path = url.split('?')[0] ?? url
  const segments = path.split('/')
  return segments[segments.length - 1] ?? ''
}

/** A page the search returns: its archives and an optional next cursor. */
interface ArchivePageSpec {
  readonly archives: ReadonlyArray<{
    readonly id: string
    readonly fileName: string
    readonly date?: string
  }>
  readonly nextCursor?: string
}

/**
 * Serves the archive search and the per-id fetch off one stateless routing rule:
 * a request with a `category` param is a search (answered by page, keyed by
 * `_pageToken` → page index), anything else is a GetById (answered by id). The
 * runner carries the bearer token so the wire can be asserted.
 */
const serveArchives = (config: {
  readonly pages: readonly ArchivePageSpec[]
  readonly harTextById: Readonly<Record<string, string>>
}): void => {
  const pageIndexOf = (token: string | undefined): number =>
    token === undefined ? 0 : Number(token.replace('cursor-', '')) - 1

  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      sentRequests.push(request)
      const params = Object.fromEntries(request.urlParams)
      if (params['category'] !== undefined) {
        const page = config.pages[pageIndexOf(params['_pageToken'])]
        const wires = (page?.archives ?? []).map((one) => archiveWire(one))
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, jsonResponse(searchset(wires, page?.nextCursor)))
        )
      }
      const id = idFromUrl(request.url)
      const wire = archiveWire({ id, fileName: `${id}.har`, harText: config.harTextById[id] })
      return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(wire)))
    })
  )
  currentRunAuthed = buildSmartRouterContext(
    { serverUrl: SERVER_URL, accessToken: ACCESS_TOKEN },
    httpLayer
  ).runAuthed
}

/** The search parameters of the nth recorded request, as a plain lookup. */
const paramsOf = (index: number): Readonly<Record<string, string | undefined>> => {
  const request = sentRequests[index]
  if (request === undefined) throw new Error(`no request recorded at index ${index}`)
  return Object.fromEntries(request.urlParams)
}

const withQueryClient = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)
