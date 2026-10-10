import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Layer, Schema } from 'effect'
import { FhirR4ResourcesRouterContext, type RunAuthed } from 'fhir-r4-react'
import type * as FhirR4React from 'fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { CHECKING_SERVER_MESSAGE, ImporterScreen } from './importer-screen.tsx'
import { formatRegistry } from './registry.ts'
import { SKIPPED_HEADING } from './results/import-results.tsx'
import {
  dicomFile,
  RECOGNIZED_HAR,
  storedSourceFile,
  type StoredSourceFile,
} from './screen-fixtures.ts'

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
 *   for the source list; the source-file source file and every resource write appear
 *   only after an explicit confirm;
 * - **the source-file source file is a reviewed resource** — a local pick shows it in
 *   its own "Source file" section, and it is written in the *same* batch as the
 *   resources it stamps (its entry first in the bundle), each resource body
 *   carrying `meta.source` naming that source file (a server-sourced HAR shows no
 *   source file section, uploads nothing, and links to the document it was fetched
 *   from);
 * - **skipping the source file keeps `meta.source`** — unticking the "Source file"
 *   row writes no `DocumentReference`, and the resources still name it (the
 *   format stamped them at decode; the id is deterministic in the file, so a
 *   later upload of the same file resolves the link);
 * - **a failing write folds into a partial result** (a rejected source file is just
 *   one failed row, not a gate on the rest), and **cancel discards with no
 *   writes**.
 */

vi.mock('fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunAuthed }
})

let currentRunAuthed: RunAuthed
let recorded: RecordedRequest[]
let queryClient: QueryClient

/**
 * jsdom's `TextEncoder` hands back a `Uint8Array` from a realm the source file codec's
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
    // The preview blocked on the server diff: badges are already resolved the
    // instant it paints (all four probes 404 → New), never popping in later.
    expect(screen.getAllByText('New').length).toBeGreaterThan(0)
    expect(writes()).toHaveLength(0)
    // The two recognized responses are named in the interactive review (per URL).
    expect(screen.getByText(/\/Patient\/pat-7/)).toBeDefined()
    expect(screen.getByText(/\/Observation\?/)).toBeDefined()
    // The source file is its own reviewable section, above the extracted rows.
    expect(screen.getByRole('checkbox', { name: 'Include all in Source file' })).toBeDefined()

    // Act — confirm (one Patient + two Observations + the source-file source file)
    await userEvent.click(screen.getByRole('button', { name: /Import 4 resources/ }))

    // Assert — writes appear only now
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Import complete/ })).toBeDefined()
    })
    expect(writes().length).toBeGreaterThan(0)
    // The results name only the formats that claimed a file. The batch has one
    // HAR and nothing else, so the "nothing to import" section must be absent
    // entirely — a confirm that planned a write per *registered* format instead
    // reported one titleless skipped row per unused format.
    expect(screen.queryByRole('heading', { name: SKIPPED_HEADING })).toBeNull()
    expect(screen.getByRole('status').textContent).toMatch(/Wrote 4 of 4 resources/)
  })

  it('writes the source-file source file in the same batch, first, and stamps every resource with it', async () => {
    // Arrange
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act — pick locally, then confirm
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Ready to import/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /Import 4 resources/ }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Import complete/ })).toBeDefined()
    })

    // Assert — one HAR-source file write, its entry first in the batch (the "Source
    // file" section is prepended), ahead of the first resource write
    const sourceFileCreate = writes().findIndex((write) =>
      write.url.includes('/DocumentReference/')
    )
    const firstResource = writes().findIndex((write) => isResourceWrite(write))
    expect(sourceFileCreate).toBeGreaterThanOrEqual(0)
    expect(firstResource).toBeGreaterThan(sourceFileCreate)

    // …and every resource write points its `meta.source` at that fresh source file
    const sourceFileId = idFromUrl(writes()[sourceFileCreate]?.url ?? '')
    const expectedSource = `DocumentReference/${sourceFileId}`
    const resourceWrites = writes().filter(isResourceWrite)
    expect(resourceWrites).toHaveLength(3)
    for (const write of resourceWrites) {
      expect(JSON.parse(write.body)).toMatchObject({ meta: { source: expectedSource } })
    }
  })

  it('lists a re-picked server source file as a pre-excluded row and uploads nothing', async () => {
    // Arrange — one source file already on the server, minted from the recognized
    // HAR exactly as this format's decode would mint it
    const stored = await storedSourceFile(
      formatRegistry.har.sourceFileFormat,
      'server-session.har',
      RECOGNIZED_HAR
    )
    currentRunAuthed = routingServer({ sourceFiles: [stored] })
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act — select it in the server list and pick it as the batch's source
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Select server-session.har' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Use selected as source' }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Ready to import/ })).toBeDefined()
    })

    // Assert — the source file is a reviewed row like any other, but the server
    // already holds exactly it, so the diff reads `unchanged` and the initial
    // selection leaves it out: three of the four rows are selected.
    const sourceFileRow = screen.getByRole('checkbox', { name: /Include DocumentReference/ })
    expect(sourceFileRow.hasAttribute('checked')).toBe(false)
    expect(screen.getByRole('button', { name: /Import 3 resources/ })).toBeDefined()

    // Act — confirm
    await userEvent.click(screen.getByRole('button', { name: /Import 3 resources/ }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Import complete/ })).toBeDefined()
    })

    // Assert — no DocumentReference write (the source file is already there), and
    // every resource links to the source file the re-pick minted, which is the one
    // it came from.
    expect(writes().some((write) => write.url.includes('/DocumentReference/'))).toBe(false)
    const resourceWrites = writes().filter(isResourceWrite)
    expect(resourceWrites).toHaveLength(3)
    for (const write of resourceWrites) {
      expect(metaSourceOf(write.body)).toBe(`DocumentReference/${stored.id}`)
    }
  })

  it('folds a failing write into a partial result that groups the failed resources by code', async () => {
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
    await userEvent.click(screen.getByRole('button', { name: /Import 4 resources/ }))

    // Assert — a partial result: the source-file source file and the Patient wrote,
    // both Observations are grouped under their failure status code (retry
    // backoff runs on the real clock).
    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: /Imported with some failures/ })).toBeDefined()
      },
      { timeout: 6000 }
    )
    expect(screen.getByText(/503 Service Unavailable/)).toBeDefined()
    expect(screen.getAllByText(/Observation\//).length).toBeGreaterThan(0)
    expect(screen.getByRole('status').textContent).toMatch(/Wrote 2 of 4/)
  })

  it("still writes a file's resources when its source-file source file is rejected, as a partial batch", async () => {
    // Arrange — the store rejects the source file `DocumentReference` entry. It rides
    // the same batch as the resources, so its rejection is one failed row — not a
    // gate that stops the rest.
    currentRunAuthed = routingServer({
      failWrite: (request) => request.url.includes('/DocumentReference/'),
    })
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act — pick locally, then confirm
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Ready to import/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /Import 4 resources/ }))

    // Assert — a partial result: the source file's failed row shows under its status,
    // yet the three resources still wrote (each stamped with the source file ref).
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Imported with some failures/ })).toBeDefined()
    })
    expect(screen.getByText(/503 Service Unavailable/)).toBeDefined()
    expect(screen.getAllByText(/DocumentReference\//).length).toBeGreaterThan(0)
    expect(writes().filter(isResourceWrite)).toHaveLength(3)
  })

  it('imports several files at once as one batch, each stamped with its own source file', async () => {
    // Arrange
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act — choose two recognized HARs in one dialog, preview them together
    await userEvent.upload(screen.getByLabelText('Import file'), [
      harFile('session-a.har'),
      harFile('session-b.har'),
    ])
    await waitFor(() => {
      // Two files × (three resources + one source-file source file) under one confirm.
      expect(screen.getByRole('button', { name: /Import 8 resources/ })).toBeDefined()
    })
    expect(writes()).toHaveLength(0)

    // Confirm the whole batch
    await userEvent.click(screen.getByRole('button', { name: /Import 8 resources/ }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Import complete/ })).toBeDefined()
    })

    // Assert — one source file per file, six resources, each pointing at one of the
    // two fresh source files.
    const sourceFileIds = writes()
      .filter((write) => write.url.includes('/DocumentReference/'))
      .map((write) => idFromUrl(write.url))
    expect(new Set(sourceFileIds).size).toBe(2)
    const sources = writes()
      .filter(isResourceWrite)
      .map((write) => metaSourceOf(write.body))
    expect(sources).toHaveLength(6)
    for (const source of sources) {
      expect(sourceFileIds.map((id) => `DocumentReference/${id}`)).toContain(source)
    }
  })

  it('imports a DICOM study of several files as one ImagingStudy with a source file per file', async () => {
    // Arrange — three files of one study: two instances of one series, one of
    // another. Decoded per file, this would be three ImagingStudys sharing an
    // id, each overwriting the last's series list.
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act — pick the study's files together, as a folder pick yields them
    await userEvent.upload(screen.getByLabelText('Import file'), [
      dicomFile('I1.dcm', { SeriesInstanceUID: 'S1', SeriesNumber: 1, SOPInstanceUID: 'I1' }),
      dicomFile('I2.dcm', { SeriesInstanceUID: 'S1', SeriesNumber: 1, SOPInstanceUID: 'I2' }),
      dicomFile('I3.dcm', { SeriesInstanceUID: 'S2', SeriesNumber: 2, SOPInstanceUID: 'I3' }),
    ])
    // Three source files + one Patient + one ServiceRequest + one ImagingStudy.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Import 6 resources/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /Import 6 resources/ }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Import complete/ })).toBeDefined()
    })

    // Assert — one ImagingStudy carrying all three instances, and one source file
    // per file, each named by the instance it stores
    const studies = writes().filter((write) => write.url.includes('/ImagingStudy/'))
    expect(studies).toHaveLength(1)
    const study = Schema.decodeUnknownSync(ImagingStudyWire)(JSON.parse(studies[0].body))
    expect(study.numberOfSeries).toBe(2)
    expect(study.numberOfInstances).toBe(3)

    const sourceFileIds = writes()
      .filter((write) => write.url.includes('/DocumentReference/'))
      .map((write) => idFromUrl(write.url))
    expect(new Set(sourceFileIds).size).toBe(3)
    const instanceFileIds = study.series.flatMap((series) =>
      series.instance.map((instance) => instance.extension[0]?.valueString)
    )
    expect(new Set(instanceFileIds)).toEqual(new Set(sourceFileIds))
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
      // 1 Patient + 1 Observation + the source-file source file remain.
      expect(screen.getByRole('button', { name: /Import 3 resources/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /Import 3 resources/ }))
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
    await userEvent.click(screen.getByRole('button', { name: /Import 4 resources/ }))
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

  it('skips the source-file source file when unticked — resources still write with meta.source', async () => {
    // Arrange
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act — pick locally (1 Patient + 2 Observations + the source-file source file)
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Ready to import/ })).toBeDefined()
    })
    // Untick the whole "Source file" section, dropping the source file from the batch.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include all in Source file' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Import 3 resources/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /Import 3 resources/ }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Import complete/ })).toBeDefined()
    })

    // Assert — no source file `DocumentReference` write, and the three resources
    // still name the sourceFile: the format stamped `meta.source` at decode, and
    // skipping the row changes what is written, not what was decoded.
    expect(writes().some((write) => write.url.includes('/DocumentReference/'))).toBe(false)
    const resourceWrites = writes().filter(isResourceWrite)
    expect(resourceWrites).toHaveLength(3)
    for (const write of resourceWrites) {
      expect(metaSourceOf(write.body)).toMatch(/^DocumentReference\/.+/)
    }
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

  it('keeps the preview painted and the settings control focused across a settings change', async () => {
    // Arrange — reach a preview over a local HAR pick
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Ready to import/ })).toBeDefined()
    })

    // Act — change the format's settings, which re-decodes and re-classifies
    const settingsForm = screen.getByRole('group', { name: 'Include' })
    const kindToggle = within(settingsForm).getAllByRole('checkbox')[0]
    expect(kindToggle).toBeDefined()
    if (kindToggle === undefined) return
    await userEvent.click(kindToggle)

    // Assert — the re-classification resolves *underneath* the panel. Blocking
    // the preview on it would unmount the whole panel, dropping the focus of
    // whatever settings control the reviewer was using — which is what made
    // the time-zone text field eject the cursor on every keystroke.
    expect(screen.queryByText(CHECKING_SERVER_MESSAGE)).toBeNull()
    expect(screen.getByRole('heading', { name: /import/i })).toBeDefined()
    expect(document.activeElement).toBe(kindToggle)

    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Include' })).getAllByRole('checkbox')[0]
      ).toBe(kindToggle)
    })
    expect(document.activeElement).toBe(kindToggle)
  })
})

// Helpers

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(status === 200 ? JSON.stringify(body) : '', {
    status,
    headers: { 'content-type': 'application/json' },
  })

const decodeBody = (body: HttpClientRequest.HttpClientRequest['body']): string =>
  body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : ''

/** Just enough of a written `ImagingStudy` to assert its counts and instance links. */
const ImagingStudyWire = Schema.Struct({
  numberOfSeries: Schema.Number,
  numberOfInstances: Schema.Number,
  series: Schema.Array(
    Schema.Struct({
      instance: Schema.Array(
        Schema.Struct({
          extension: Schema.optionalWith(
            Schema.Array(Schema.Struct({ valueString: Schema.optional(Schema.String) })),
            { default: () => [] }
          ),
        })
      ),
    })
  ),
})

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

/** Whether a write is a FHIR resource write (a Patient or Observation), not the source file. */
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

/**
 * A stub transport that records every request and routes it: a `category` search
 * answers with the configured source files, a `DocumentReference/<id>` GET answers
 * with that source file, and every PUT echoes the written body back (or a 503 when
 * `failWrite` says so). One stateless rule per shape — enough to drive the whole
 * flow and read the write log back.
 */
const routingServer = (config: {
  readonly sourceFiles?: readonly StoredSourceFile[]
  readonly failWrite?: (request: { readonly method: string; readonly url: string }) => boolean
}): RunAuthed => {
  const sourceFiles = config.sourceFiles ?? []
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const body = decodeBody(request.body)
      const params = Object.fromEntries(request.urlParams)

      // A `POST /` at the FHIR base with a Bundle body is `fhir-r4`'s
      // bundle-submit — a batch of PUT entries (persistBatchBundle) or GET
      // entries (classifyAgainstServer). Unwrap it: record each entry as its
      // own request (method + url from `entry.request`), and mirror the
      // batch-response bundle. That keeps `writes()` / `isResourceWrite`
      // seeing one recorded request per resource operation.
      if (request.method === 'POST' && (request.url === '/' || request.url.endsWith('/'))) {
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
            const entryUrl = `/${entryReq.url}`
            const entryBody = entry.resource === undefined ? '' : JSON.stringify(entry.resource)
            recorded.push({ method: entryReq.method, url: entryUrl, body: entryBody })
            if (
              entryReq.method === 'PUT' &&
              config.failWrite?.({ method: entryReq.method, url: entryUrl }) === true
            ) {
              responseEntries.push({ response: { status: '503 Service Unavailable' } })
              continue
            }
            if (entryReq.method === 'GET') {
              // The only resources this suite's server already holds are the
              // configured source files; every other classify probe is a miss.
              const stored = sourceFiles.find((one) => entryUrl.endsWith(`/${one.id}`))
              responseEntries.push(
                stored === undefined
                  ? { response: { status: '404 Not Found' } }
                  : { response: { status: '200 OK' }, resource: stored.wire }
              )
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

      recorded.push({ method: request.method, url: request.url, body })
      if (request.method === 'GET' && params['category'] !== undefined) {
        const wires = sourceFiles.map((one) => one.wire)
        return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(searchset(wires))))
      }
      if (request.method === 'GET') {
        const sourceFile = sourceFiles.find((one) => one.id === idFromUrl(request.url))
        if (sourceFile === undefined) {
          return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(null, 404)))
        }
        return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(sourceFile.wire)))
      }
      if (config.failWrite?.({ method: request.method, url: request.url }) === true) {
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

const withQueryClient = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)
