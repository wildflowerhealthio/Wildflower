import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DICOM_SOURCE_FILE_CODE, DICOM_SYSTEM } from 'dicom-importer-core/source-file'
import { DateTime, Effect, Layer, Schema } from 'effect'
import type * as FhirR4React from 'fhir-r4-react'
import type { RunAuthed } from 'fhir-r4-react'
import { buildSmartRouterContext } from 'fhir-r4-react/smart'
import { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'har-importer-core/source-file'
import type { PickedFile } from 'importer-fundamentals'
import {
  LIFELABS_PDF_SOURCE_FILE_CODE,
  LIFELABS_SYSTEM,
} from 'lifelabs-pdf-importer-core/source-file'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { ServerSourceFileList, UNDATED_LABEL } from './server-source-file-list.tsx'

/**
 * The uploaded-source-files list, driven over a stub `HttpClient`, exercising:
 *
 *   - a mixed searchset (a HAR and a LifeLabs PDF) both list flat under the
 *     format-neutral heading, each with a selection control and a Preview
 *     action;
 *   - Preview opens the modal, fetches the file through the row's format's
 *     source file codec, and renders the bytes (a JSON source file as pretty-printed
 *     text, a PDF via an `<iframe>` at a `blob:` URL);
 *   - the one pick action fetches every selected row and calls `onPick` with
 *     their names and bytes;
 *   - `maxPicks={1}` renders radios, so one selection replaces another;
 *   - the bottom sentinel fetches the next page when it scrolls into view.
 *
 * jsdom does not implement `<dialog>`, so the two methods `Dialog` calls
 * are patched per-test — same trick `resource-editor.test.tsx` uses.
 *
 * jsdom also does not implement `URL.createObjectURL`; the preview blob
 * plumbing calls it, so we install a synthetic implementation that hands
 * back a marker string. Nothing here asserts the URL loads. jsdom has no
 * `IntersectionObserver` either — every test but the paging one installs a
 * quiet stub, so the sentinel mounts and never fires.
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
const UPLOADED_AT = DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z'))

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

  stubQuietIntersectionObserver()
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  restoreDialog('showModal', originalShowModal)
  restoreDialog('close', originalClose)
})

describe('ServerSourceFileList', () => {
  it('should list a HAR and a LifeLabs PDF source file together under the format-neutral heading', async () => {
    // Arrange — a mixed searchset carrying one of each format
    serveArchives([
      harArchiveWire({ id: 'har-1', fileName: 'portal.har', lastUpdated: UPLOADED_AT }),
      lifelabsPdfArchiveWire({ id: 'pdf-1', fileName: 'report.pdf', lastUpdated: UPLOADED_AT }),
    ])
    render(<ServerSourceFileList onPick={() => undefined} />, { wrapper: withQueryClient })

    // Assert — the format-neutral heading and both rows land, flat, each with
    // a selection control and a Preview action bearing the file name
    expect(
      await screen.findByRole('heading', { name: 'Uploaded source files on the FHIR server' })
    ).toBeDefined()
    expect(await screen.findByText('portal.har')).toBeDefined()
    expect(screen.getByText('report.pdf')).toBeDefined()
    expect(screen.getByRole('checkbox', { name: 'Select portal.har' })).toBeDefined()
    expect(screen.getByRole('checkbox', { name: 'Select report.pdf' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Preview portal.har' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Preview report.pdf' })).toBeDefined()
  })

  it('should date a row by the stored resource, and say so when it states none', async () => {
    serveArchives([
      harArchiveWire({ id: 'har-1', fileName: 'portal.har', lastUpdated: UPLOADED_AT }),
      harArchiveWire({ id: 'har-2', fileName: 'undated.har', lastUpdated: undefined }),
    ])
    render(<ServerSourceFileList onPick={() => undefined} />, { wrapper: withQueryClient })

    expect(await screen.findByText('2026-08-13')).toBeDefined()
    expect(screen.getByText(UNDATED_LABEL)).toBeDefined()
  })

  it('should show what a row is a source of as its own line, grouping nothing on it', async () => {
    serveArchives([
      dicomArchiveWire({ id: 'dcm-1', fileName: 'I1.dcm', study: 'study-a' }),
      dicomArchiveWire({ id: 'dcm-2', fileName: 'I2.dcm', study: 'study-a' }),
    ])
    render(<ServerSourceFileList onPick={() => undefined} />, { wrapper: withQueryClient })

    expect(await screen.findByText('I1.dcm')).toBeDefined()
    expect(screen.getAllByText('source of ImagingStudy/study-a')).toHaveLength(2)
    // Flat: two rows, no study heading over them.
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('should read a HAR archive contents and render it as pretty-printed JSON when Preview is clicked', async () => {
    // Arrange
    serveArchives([
      harArchiveWire({ id: 'har-1', fileName: 'portal.har', lastUpdated: UPLOADED_AT }),
    ])
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
    // The source file was fetched by id off the FHIR base
    const fetchRequest = sentRequests.find((request) =>
      request.url.includes('/DocumentReference/har-1')
    )
    expect(fetchRequest?.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(screen.getByTestId('preview-download')).toBeDefined()
  })

  it('should read a LifeLabs PDF and render it as an iframe at a blob URL when Preview is clicked', async () => {
    // Arrange
    serveArchives([
      lifelabsPdfArchiveWire({ id: 'pdf-1', fileName: 'report.pdf', lastUpdated: UPLOADED_AT }),
    ])
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

  it('should pick the selected file as a source, fetching it by id', async () => {
    // Arrange
    serveArchives([
      harArchiveWire({ id: 'har-1', fileName: 'portal.har', lastUpdated: UPLOADED_AT }),
    ])
    let picked: readonly PickedFile.NamedBytes[] | undefined
    render(
      <ServerSourceFileList
        onPick={(chosen) => {
          picked = chosen
        }}
      />,
      { wrapper: withQueryClient }
    )
    await screen.findByRole('checkbox', { name: 'Select portal.har' })

    // Act
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select portal.har' }))
    await userEvent.click(screen.getByRole('button', { name: 'Use selected as source' }))

    // Assert — onPick fires with the stored file's own name and bytes; no id
    // travels with it, because re-picking mints the same one.
    await waitFor(() => {
      expect(picked !== undefined).toBe(true)
    })
    expect(picked?.map((one) => one.fileName)).toEqual(['portal.har'])
    expect(new TextDecoder().decode(picked?.[0]?.bytes ?? new Uint8Array())).toBe(HAR_TEXT)
  })

  it('should pick rows selected across the list as one list', async () => {
    serveArchives([
      dicomArchiveWire({ id: 'dcm-1', fileName: 'I1.dcm', study: 'study-a' }),
      dicomArchiveWire({ id: 'dcm-2', fileName: 'I2.dcm', study: 'study-a' }),
      harArchiveWire({ id: 'har-1', fileName: 'portal.har', lastUpdated: UPLOADED_AT }),
    ])
    let picked: readonly PickedFile.NamedBytes[] | undefined
    render(
      <ServerSourceFileList
        onPick={(all) => {
          picked = all
        }}
      />,
      { wrapper: withQueryClient }
    )
    await screen.findByRole('checkbox', { name: 'Select I1.dcm' })

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select I2.dcm' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select portal.har' }))
    await userEvent.click(screen.getByRole('button', { name: 'Use selected as source' }))

    await waitFor(() => {
      expect(picked !== undefined).toBe(true)
    })
    // Server order, not click order — the pick is the listed selection.
    expect(picked?.map((one) => one.fileName)).toEqual(['I2.dcm', 'portal.har'])
  })

  it('should offer no pick with nothing selected, and unselect a row that was selected', async () => {
    serveArchives([
      dicomArchiveWire({ id: 'dcm-1', fileName: 'I1.dcm', study: 'study-a' }),
      dicomArchiveWire({ id: 'dcm-2', fileName: 'I2.dcm', study: 'study-a' }),
    ])
    render(<ServerSourceFileList onPick={() => undefined} />, { wrapper: withQueryClient })
    const row = await screen.findByRole('checkbox', { name: 'Select I2.dcm' })
    const pickAction = screen.getByRole('button', { name: 'Use selected as source' })
    expect(pickAction.hasAttribute('disabled')).toBe(true)

    await userEvent.click(row)
    expect(pickAction.hasAttribute('disabled')).toBe(false)
    await userEvent.click(row)

    expect(screen.getByRole('checkbox', { name: 'Select I2.dcm', checked: false })).toBeDefined()
    expect(pickAction.hasAttribute('disabled')).toBe(true)
  })

  describe('under a cap of one', () => {
    it('should render radios, so selecting one row deselects every other', async () => {
      // The anonymizer's `serverSource` slot, and the importer app's own tab:
      // a host with nowhere to put a two-file pick.
      serveArchives([
        dicomArchiveWire({ id: 'dcm-1', fileName: 'I1.dcm', study: 'study-a' }),
        dicomArchiveWire({ id: 'dcm-2', fileName: 'I2.dcm', study: 'study-a' }),
      ])
      render(<ServerSourceFileList maxPicks={1} onPick={() => undefined} />, {
        wrapper: withQueryClient,
      })
      const first = await screen.findByRole('radio', { name: 'Select I1.dcm' })
      expect(screen.queryByRole('checkbox')).toBeNull()

      await userEvent.click(first)
      expect(screen.getByRole('radio', { name: 'Select I1.dcm', checked: true })).toBeDefined()

      await userEvent.click(screen.getByRole('radio', { name: 'Select I2.dcm' }))
      expect(screen.getByRole('radio', { name: 'Select I1.dcm', checked: false })).toBeDefined()
      expect(screen.getByRole('radio', { name: 'Select I2.dcm', checked: true })).toBeDefined()
    })

    it('should name the action for one file and pick exactly that one', async () => {
      serveArchives([
        dicomArchiveWire({ id: 'dcm-1', fileName: 'I1.dcm', study: 'study-a' }),
        dicomArchiveWire({ id: 'dcm-2', fileName: 'I2.dcm', study: 'study-a' }),
      ])
      let picked: readonly PickedFile.NamedBytes[] | undefined
      render(
        <ServerSourceFileList
          maxPicks={1}
          onPick={(all) => {
            picked = all
          }}
        />,
        { wrapper: withQueryClient }
      )
      await userEvent.click(await screen.findByRole('radio', { name: 'Select I2.dcm' }))
      expect(screen.queryByRole('button', { name: 'Use selected as source' })).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'Use as source' }))

      await waitFor(() => {
        expect(picked !== undefined).toBe(true)
      })
      expect(picked?.map((one) => one.fileName)).toEqual(['I2.dcm'])
    })
  })

  it('should cap the selection, disabling the rest once it is reached', async () => {
    serveArchives([
      dicomArchiveWire({ id: 'dcm-1', fileName: 'I1.dcm', study: 'study-a' }),
      dicomArchiveWire({ id: 'dcm-2', fileName: 'I2.dcm', study: 'study-a' }),
      dicomArchiveWire({ id: 'dcm-3', fileName: 'I3.dcm', study: 'study-a' }),
    ])
    render(<ServerSourceFileList maxPicks={2} onPick={() => undefined} />, {
      wrapper: withQueryClient,
    })
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select I1.dcm' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select I2.dcm' }))

    const third = screen.getByRole('checkbox', { name: 'Select I3.dcm' })
    expect(third.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Select I1.dcm' }).hasAttribute('disabled')).toBe(
      false
    )
  })

  it('should fetch the next page when the bottom sentinel scrolls into view', async () => {
    // Arrange: capture a `trigger` for every IntersectionObserver so the test
    // can simulate the sentinel entering the viewport.
    const observers: { readonly trigger: () => void }[] = []
    class MockIntersectionObserver {
      readonly #notify: () => void
      constructor(callback: (entries: readonly { readonly isIntersecting: boolean }[]) => void) {
        this.#notify = () => {
          callback([{ isIntersecting: true }])
        }
        observers.push({ trigger: this.#notify })
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

    servePages([
      searchset(
        [harArchiveWire({ id: 'har-1', fileName: 'one.har', lastUpdated: UPLOADED_AT })],
        'cursor-2'
      ),
      searchset([harArchiveWire({ id: 'har-2', fileName: 'two.har', lastUpdated: UPLOADED_AT })]),
    ])
    render(<ServerSourceFileList onPick={() => undefined} />, { wrapper: withQueryClient })
    await screen.findByText('one.har')

    // Act — the sentinel mounted because a next page exists; fire it.
    await waitFor(() => {
      expect(observers.length).toBeGreaterThan(0)
    })
    act(() => {
      observers.at(-1)?.trigger()
    })

    // Assert — the second page loads and lists, and paging stops there.
    expect(await screen.findByText('two.har')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Show more source files' })).toBeNull()
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

/** `meta.lastUpdated` as the server states it, or nothing at all. */
const metaOf = (lastUpdated: DateTime.Utc | undefined): Record<string, unknown> =>
  lastUpdated === undefined ? {} : { meta: { lastUpdated: DateTime.formatIso(lastUpdated) } }

const harArchiveWire = (fields: {
  readonly id: string
  readonly fileName: string
  readonly lastUpdated: DateTime.Utc | undefined
}): unknown => {
  const coding = [{ system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE }]
  return {
    resourceType: 'DocumentReference',
    id: fields.id,
    status: 'current',
    ...metaOf(fields.lastUpdated),
    type: { coding },
    category: [{ coding }],
    content: [
      {
        attachment: {
          contentType: 'application/json',
          data: base64(HAR_TEXT),
          title: fields.fileName,
        },
      },
    ],
  }
}

const lifelabsPdfArchiveWire = (fields: {
  readonly id: string
  readonly fileName: string
  readonly lastUpdated: DateTime.Utc | undefined
}): unknown => {
  const coding = [{ system: LIFELABS_SYSTEM, code: LIFELABS_PDF_SOURCE_FILE_CODE }]
  return {
    resourceType: 'DocumentReference',
    id: fields.id,
    status: 'current',
    ...metaOf(fields.lastUpdated),
    type: { coding },
    category: [{ coding }],
    content: [
      {
        attachment: {
          contentType: 'application/pdf',
          data: base64(PDF_BYTES_TEXT),
          title: fields.fileName,
        },
      },
    ],
  }
}

const dicomArchiveWire = (fields: {
  readonly id: string
  readonly fileName: string
  readonly study: string
}): unknown => {
  const coding = [{ system: DICOM_SYSTEM, code: DICOM_SOURCE_FILE_CODE }]
  return {
    resourceType: 'DocumentReference',
    id: fields.id,
    status: 'current',
    meta: { lastUpdated: DateTime.formatIso(UPLOADED_AT) },
    type: { coding },
    category: [{ coding }],
    subject: { reference: 'Patient/p-1' },
    context: { related: [{ reference: `ImagingStudy/${fields.study}` }] },
    content: [
      {
        attachment: {
          contentType: 'application/dicom',
          data: base64('DICM stand-in'),
          title: fields.fileName,
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
            url: `${SERVER_URL}/DocumentReference?category=any&_pageToken=${nextCursor}`,
          },
        ],
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
/** The resources one searchset carries, for the id map above. */
const entriesOf = (page: unknown): readonly unknown[] => {
  if (typeof page !== 'object' || page === null) return []
  const entry: unknown = Reflect.get(page, 'entry')
  if (!Array.isArray(entry)) return []
  return entry.map((one: unknown) =>
    typeof one === 'object' && one !== null ? Reflect.get(one, 'resource') : undefined
  )
}

const idOf = (resource: unknown): string | undefined => {
  if (typeof resource !== 'object' || resource === null) return undefined
  const value: unknown = Reflect.get(resource, 'id')
  return typeof value === 'string' ? value : undefined
}

/** A quiet IntersectionObserver — the sentinel mounts but never fires. */
const stubQuietIntersectionObserver = (): void => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
}

const serveArchives = (resources: readonly unknown[]): void => {
  servePages([searchset(resources)], resources)
}

/**
 * Serves one searchset per page, in order, plus the per-id GetById off every
 * resource any of them carries.
 */
const servePages = (pages: readonly unknown[], resources?: readonly unknown[]): void => {
  const byId = new Map<string, unknown>()
  for (const resource of resources ?? pages.flatMap(entriesOf)) {
    const id = idOf(resource)
    if (id !== undefined) byId.set(id, resource)
  }
  let served = 0
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      sentRequests.push(request)
      const params = Object.fromEntries(request.urlParams)
      if (params['category'] !== undefined) {
        const page = pages[served] ?? pages.at(-1)
        served += 1
        return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(page)))
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
