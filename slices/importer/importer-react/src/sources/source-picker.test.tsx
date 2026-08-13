import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DateTime, Effect, Either, Layer, Schema } from 'effect'
import type * as FhirR4React from 'fhir-r4-react'
import type { RunAuthed } from 'fhir-r4-react'
import { buildSmartRouterContext } from 'fhir-r4-react/smart'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'web-trace-core/codec'

import { HAR_ARCHIVE_CATEGORY_TOKEN } from '../queries/har-archives.ts'
import { REJECTION_MESSAGE } from './local-har.ts'
import { SourcePicker } from './source-picker.tsx'

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
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunAuthed }
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

let currentRunAuthed: RunAuthed
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
    const picks: Array<{ fileName: string; text: string; source: unknown }> = []
    render(<SourcePicker onPick={(picked) => picks.push(picked)} />, { wrapper: withQueryClient })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /portal-session\.har/ })).toBeDefined()
    })

    // Act 1 — chosen through the OS picker
    await userEvent.upload(screen.getByLabelText('HAR file'), harFile('portal-session.har'))
    // Act 2 — dropped on the zone via a synthesized DataTransfer
    fireEvent.drop(zone(), { dataTransfer: dataTransferOf(harFile('portal-session.har')) })
    await waitFor(() => {
      expect(picks).toHaveLength(2)
    })
    // Act 3 — selected from the server list
    await userEvent.click(screen.getByRole('button', { name: /portal-session\.har/ }))
    await waitFor(() => {
      expect(picks).toHaveLength(3)
    })

    // Assert — every path carried the same text; the two local picks are identical
    expect(picks.map((pick) => pick.text)).toEqual([VALID_HAR, VALID_HAR, VALID_HAR])
    expect(picks[0]).toEqual({
      fileName: 'portal-session.har',
      text: VALID_HAR,
      source: { _tag: 'local' },
    })
    expect(picks[1]).toEqual(picks[0])
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
    let picked: { text: string; source: unknown } | undefined
    render(<SourcePicker onPick={(one) => (picked = one)} />, { wrapper: withQueryClient })

    // Assert — the row shows the title and the upload date
    await waitFor(() => {
      expect(screen.getByText('portal-session.har')).toBeDefined()
    })
    expect(screen.getByText(uploadedAt)).toBeDefined()

    // …the search went out filtered by the archive category, sized, and authed
    expect(paramsOf(0)['category']).toBe(HAR_ARCHIVE_CATEGORY_TOKEN)
    expect(HAR_ARCHIVE_CATEGORY_TOKEN).toBe(`${WEB_TRACE_CODE_SYSTEM}|${HAR_ARCHIVE_CODE}`)
    expect(paramsOf(0)['_count']).toBe('50')
    expect(sentRequests[0]?.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`)

    // Act — select the row
    await userEvent.click(screen.getByRole('button', { name: /portal-session\.har/ }))

    // Assert — the chosen archive is fetched and decoded to its HAR text
    await waitFor(() => {
      expect(picked?.text).toBe(VALID_HAR)
    })
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
    render(<SourcePicker onPick={() => undefined} />, { wrapper: withQueryClient })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /first\.har/ })).toBeDefined()
    })

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Show more archives' }))

    // Assert — the second search carried the cursor, and both pages are listed
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /second\.har/ })).toBeDefined()
    })
    expect(paramsOf(0)['_pageToken']).toBeUndefined()
    expect(paramsOf(1)['_pageToken']).toBe('cursor-2')
  })

  it('should expose the drop zone as a labeled button and the file input as a named control', () => {
    // Arrange
    serveArchives({ pages: [{ archives: [] }], harTextById: {} })
    render(<SourcePicker onPick={() => undefined} />, { wrapper: withQueryClient })

    // Assert — a real button (so keyboard-activatable) with an accessible name,
    // inside a labeled region, and a named file input drop is an enhancement over
    const region = screen.getByRole('region', { name: 'HAR source' })
    const button = screen.getByRole('button', { name: /Choose a HAR file, or drop one here/ })
    expect(region).toBeDefined()
    expect(button.tagName).toBe('BUTTON')
    expect(screen.getByLabelText('HAR file')).toBeDefined()
  })

  it('should reject a dropped file that is not a HAR at the picker, without calling onPick', async () => {
    // Arrange
    serveArchives({ pages: [{ archives: [] }], harTextById: {} })
    const picks: unknown[] = []
    render(<SourcePicker onPick={(picked) => picks.push(picked)} />, { wrapper: withQueryClient })

    // Act — a text file, not a HAR
    fireEvent.drop(zone(), {
      dataTransfer: dataTransferOf(new File(['not a har'], 'notes.txt', { type: 'text/plain' })),
    })

    // Assert — the failure lands here, next to the control, and nothing is picked
    await waitFor(() => {
      expect(screen.getByText(REJECTION_MESSAGE)).toBeDefined()
    })
    expect(screen.getByRole('alert')).toBeDefined()
    expect(picks).toHaveLength(0)
  })
})

// Helpers

/** Text as base64, the way the archive codec stores the file's bytes. */
const base64 = Schema.encodeSync(Schema.StringFromBase64)

/** A real HAR `File`, for the OS-picker (`upload`) and drop paths. */
const harFile = (name: string): File => new File([VALID_HAR], name, { type: 'application/json' })

/** The drop-and-pick zone button. */
const zone = (): HTMLElement =>
  screen.getByRole('button', { name: /Choose a HAR file, or drop one here/ })

/**
 * A `DataTransfer`-like carrying one file, enough for a synthesized `drop`.
 *
 * @remarks
 * jsdom's `DataTransfer` does not populate `files` from `items.add`, so the drop
 * handler is fed a plain object exposing exactly the `files.item(0)` it reads.
 */
const dataTransferOf = (file: File): { readonly files: Pick<FileList, 'item'> } => ({
  files: { item: (index: number): File | null => (index === 0 ? file : null) },
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
  // `SERVER_URL` is addressable, so this is always a `Right`; unwrap or throw.
  currentRunAuthed = Either.getOrThrowWith(
    buildSmartRouterContext({ serverUrl: SERVER_URL, accessToken: ACCESS_TOKEN }, httpLayer),
    (error) => error
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
