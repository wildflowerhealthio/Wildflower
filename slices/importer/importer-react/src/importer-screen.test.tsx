import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { RunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import type * as FhirR4React from '@wildflowerhealthio/fhir-r4-react'
import type * as FhirR4Smart from '@wildflowerhealthio/fhir-r4-react/smart'
import type { RunSmart } from '@wildflowerhealthio/fhir-r4-react/smart'
import { Schema } from 'effect'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { ImporterScreen } from './importer-screen.tsx'
import {
  CANCEL_IMPORT_LABEL,
  CHOOSE_OTHER_FILES_LABEL,
  COMPLETE_HEADING,
  IMPORT_MORE_FILES_LABEL,
  NO_RECORDS_READ_SENTENCE,
  NOT_RECOGNISED_LINE,
  NOTHING_TO_IMPORT_SENTENCE,
  READ_FAILED_MESSAGE,
  REFUSED_MESSAGE,
  UNREADABLE_LINE,
} from './plan/plan-text.ts'
import { formatRegistry } from './registry.ts'
import {
  dicomFile,
  NAMED_PATIENT_HAR,
  RECOGNIZED_HAR,
  storedSourceFile,
} from './screen-fixtures.ts'
import {
  bundleTypes,
  clearRecorded,
  idFromUrl,
  isResourceWrite,
  metaSourceOf,
  reads,
  routingServer,
  writes,
} from './screen-server.test-helpers.ts'

/**
 * The whole import flow, driven end to end over the real screen → page hook
 * → FHIR client → `HttpClient` path with a recording stub server. Only the
 * runner seams (`useRunAuthed`, `useRunSmart`) are replaced, so every request
 * the flow sends lands in one ordered log the tests read.
 *
 * The load-bearing assertions are the opt-in seam itself: reading files into
 * their import plan sends searches and reads only, and Import sends the plan
 * as one transaction, the source files among its records and every record
 * naming its source file in `meta.source`; a refused transaction writes
 * nothing and keeps the plan.
 */

vi.mock('@wildflowerhealthio/fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunPlan ?? currentRunAuthed }
})

vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4Smart>()
  return { ...actual, useRunSmart: (): RunSmart => currentRunAuthed }
})

let currentRunAuthed: RunSmart
/** The runner the plan reads and writes through, when not the page's own. */
let currentRunPlan: RunAuthed | undefined
let queryClient: QueryClient

/**
 * jsdom's `TextEncoder` hands back a `Uint8Array` from a realm the source file codec's
 * `Uint8ArrayFromSelf` schema rejects on `instanceof` — a purely jsdom artifact,
 * since a browser has one realm and a real capture's bytes always satisfy the
 * check. Re-wrapping the encoder's output through the ambient `Uint8Array` (the
 * one the schema is checked against, per `upload-har.test`) reproduces the
 * single-realm behaviour the source file mint's encode has in a browser.
 */
const AmbientTextEncoder = globalThis.TextEncoder
class RealmSafeTextEncoder extends AmbientTextEncoder {
  override encode(input?: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(super.encode(input))
  }
}

beforeEach(() => {
  currentRunPlan = undefined
  clearRecorded()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('TextEncoder', RealmSafeTextEncoder)
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ImporterScreen', () => {
  it('reads a capture into its import plan, sending only searches and reads', async () => {
    // Arrange
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))

    // Assert — the source file, the Patient and two Observations, all new
    const summary = await screen.findByRole('region', { name: 'Summary' })
    expect(within(summary).getByRole('heading').textContent).toBe('4 records from 1 file')
    expect(countsIn(summary)).toEqual({
      Create: ['4'],
      Update: ['0'],
      'Link to existing': ['0'],
      'Needs a decision': ['0'],
    })
    expect(fileLinesIn(summary)).toEqual([['portal-session.har', '4 records · 4 new']])
    expect(statusLine()).toBe('Written as one transaction: all records or none.')
    expect(importButton().textContent).toBe('Import · 4 new, 0 updated, 0 linked')
    // The picker's source list, one identifier search per type, and one
    // batch reading the record under each id the import would write.
    expect(writes()).toHaveLength(0)
    expect(bundleTypes()).toEqual(['batch'])
    expect(reads().toSorted()).toEqual(
      [
        'search DocumentReference?_count&_sort&category',
        'search Patient?_count&identifier',
        'search Observation?_count&identifier',
        'read DocumentReference',
        'read Patient',
        'read Observation',
        'read Observation',
      ].toSorted()
    )
  })

  it('writes the plan as one transaction of every record and its source file, each record naming it', async () => {
    // Arrange
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))

    // Act
    await userEvent.click(await findImportButton())

    // Assert
    await screen.findByRole('heading', { name: COMPLETE_HEADING })
    expect(screen.getByRole('status').textContent).toBe(
      `✓Success: 4 new, 0 updated, 0 linked. ${IMPORT_MORE_FILES_LABEL}`
    )
    expect(bundleTypes()).toEqual(['batch', 'transaction'])
    const sourceFiles = writes().filter((write) => write.url.includes('/DocumentReference/'))
    expect(sourceFiles).toHaveLength(1)
    const sourceFile = `DocumentReference/${idFromUrl(sourceFiles[0]?.url ?? '')}`
    const records = writes().filter(isResourceWrite)
    expect(records).toHaveLength(3)
    expect(records.map((write) => metaSourceOf(write.body))).toEqual([
      sourceFile,
      sourceFile,
      sourceFile,
    ])
  })

  it('keeps the plan when the server refuses the transaction, and writes it when Import is pressed again', async () => {
    // Arrange — the server refuses the first transaction only
    let refusals = 0
    currentRunAuthed = routingServer({
      failWrite: (request) => {
        if (refusals > 0 || !request.url.includes('/DocumentReference/')) return false
        refusals += 1
        return true
      },
    })
    render(<ImporterScreen />, { wrapper: withQueryClient })
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))

    // Act
    await userEvent.click(await findImportButton())

    // Assert — the refusal is said, the plan is still up, and nothing landed
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(REFUSED_MESSAGE)).toBeDefined()
    expect(
      within(alert)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['Transaction failed at entry 0'])
    expect(screen.getByRole('region', { name: 'Summary' })).toBeDefined()
    expect(writes().filter(isResourceWrite)).toHaveLength(0)

    // Act — import again
    await userEvent.click(importButton())

    // Assert
    await screen.findByRole('heading', { name: COMPLETE_HEADING })
    expect(bundleTypes()).toEqual(['batch', 'transaction', 'transaction'])
    expect(writes().filter(isResourceWrite)).toHaveLength(3)
  })

  it('offers nothing to import for a capture already imported, and writes nothing', async () => {
    // Arrange — import the capture once, then choose it again
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
    await userEvent.click(await findImportButton())
    await userEvent.click(await screen.findByRole('button', { name: IMPORT_MORE_FILES_LABEL }))
    const written = writes().length

    // Act
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))

    // Assert — every record links to the record the first import wrote
    const summary = await screen.findByRole('region', { name: 'Summary' })
    expect(fileLinesIn(summary)).toEqual([['portal-session.har', '4 records · 4 linked']])
    expect(statusLine()).toBe(NOTHING_TO_IMPORT_SENTENCE)
    expect(screen.queryByRole('button', { name: /^Import ·/ })).toBeNull()
    expect(writes()).toHaveLength(written)
  })

  it('links a source file picked off the server to the stored one rather than writing it again', async () => {
    // Arrange — one source file already on the server, minted from the
    // capture exactly as the import stage would mint it
    const stored = await storedSourceFile(
      formatRegistry.har.sourceFileFormat,
      'server-session.har',
      RECOGNIZED_HAR
    )
    currentRunAuthed = routingServer({ sourceFiles: [stored] })
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Select server-session.har' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Use selected as source' }))
    await userEvent.click(await findImportButton())
    await screen.findByRole('heading', { name: COMPLETE_HEADING })

    // Assert — no source file written, and every record names the stored one
    expect(screen.getByRole('status').textContent).toBe(
      `✓Success: 3 new, 0 updated, 1 linked. ${IMPORT_MORE_FILES_LABEL}`
    )
    expect(writes().some((write) => write.url.includes('/DocumentReference/'))).toBe(false)
    expect(
      writes()
        .filter(isResourceWrite)
        .map((write) => metaSourceOf(write.body))
    ).toEqual([
      `DocumentReference/${stored.id}`,
      `DocumentReference/${stored.id}`,
      `DocumentReference/${stored.id}`,
    ])
  })

  it('leaves a Patient two stored records carry the identifier of open, and blocks the import on it', async () => {
    // Arrange — two stored Patients carrying the identifier the capture's Patient has
    currentRunAuthed = routingServer({
      stored: ['s-1', 's-2'].map((id) => ({
        resourceType: 'Patient',
        id,
        identifier: [{ system: 'https://r4.example.org/baseR4/Patient', value: 'pat-7' }],
      })),
    })
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act
    await userEvent.upload(
      screen.getByLabelText('Import file'),
      new File([NAMED_PATIENT_HAR], 'a.har', { type: 'application/json' })
    )

    // Assert
    const summary = await screen.findByRole('region', { name: 'Summary' })
    expect(countsIn(summary)['Needs a decision']).toEqual(['1', '1 open'])
    expect(fileLinesIn(summary)).toEqual([['a.har', '4 records · 3 new · 1 open']])
    expect(statusLine()).toBe('Select a Patient record for Tyra Banks from a.har.')
    expect(importButton().disabled).toBe(true)
  })

  it('says a file no format recognises and a file that could not be read, each on its own line', async () => {
    // Arrange — two stored source files picked off the server: one no format
    // recognises, and one named as a HAR that is not one
    const notes = await storedSourceFile(formatRegistry.har.sourceFileFormat, 'notes.txt', 'words')
    const broken = await storedSourceFile(
      formatRegistry.har.sourceFileFormat,
      'broken.har',
      'words'
    )
    currentRunAuthed = routingServer({ sourceFiles: [notes, broken] })
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select notes.txt' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select broken.har' }))
    await userEvent.click(screen.getByRole('button', { name: 'Use selected as source' }))

    // Assert — no records, both files counted, and nothing to import
    const summary = await screen.findByRole('region', { name: 'Summary' })
    expect(within(summary).getByRole('heading').textContent).toBe('0 records from 2 files')
    expect(fileLinesIn(summary)).toEqual([
      ['broken.har', UNREADABLE_LINE],
      ['notes.txt', NOT_RECOGNISED_LINE],
    ])
    expect(statusLine()).toBe(NO_RECORDS_READ_SENTENCE)
    expect(screen.queryByRole('button', { name: /^Import ·/ })).toBeNull()
  })

  it('says the files could not be planned when the runner rejects the read, and goes back to the files', async () => {
    // Arrange — the page's own runner lists the source files; the plan's
    // runner rejects, as a sign-in that lapsed does
    currentRunAuthed = routingServer({})
    currentRunPlan = () => Promise.reject(new Error('Signed out'))
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))

    // Assert
    expect((await screen.findByRole('alert')).textContent).toBe(
      `⚠Error: ${READ_FAILED_MESSAGE} ${CHOOSE_OTHER_FILES_LABEL}`
    )
    await userEvent.click(screen.getByRole('button', { name: CHOOSE_OTHER_FILES_LABEL }))
    expect(screen.getByRole('region', { name: 'File source' })).toBeDefined()
  })

  it('offers no way to leave while the transaction is in flight, and completes once it lands', async () => {
    // Arrange — the server holds the transaction until released
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    currentRunAuthed = routingServer({ transactionsHeldUntil: held })
    render(<ImporterScreen />, { wrapper: withQueryClient })
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))

    // Act
    await userEvent.click(await findImportButton())

    // Assert — the button is disabled and there is no Cancel import
    expect(importButton().disabled).toBe(true)
    expect(screen.queryByRole('button', { name: CANCEL_IMPORT_LABEL })).toBeNull()

    // Act
    release()

    // Assert
    await screen.findByRole('heading', { name: COMPLETE_HEADING })
    expect(writes().filter(isResourceWrite)).toHaveLength(3)
  })

  it('says the files could not be planned when a search fails, and goes back to the files', async () => {
    // Arrange
    currentRunAuthed = routingServer({ failSearches: true })
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))

    // Assert
    expect((await screen.findByRole('alert')).textContent).toBe(
      `⚠Error: ${READ_FAILED_MESSAGE} ${CHOOSE_OTHER_FILES_LABEL}`
    )

    // Act
    await userEvent.click(screen.getByRole('button', { name: CHOOSE_OTHER_FILES_LABEL }))

    // Assert
    expect(screen.getByRole('region', { name: 'File source' })).toBeDefined()
  })

  it('goes back to choosing files with nothing written when the import is cancelled', async () => {
    // Arrange
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))

    // Act
    await userEvent.click(await screen.findByRole('button', { name: CANCEL_IMPORT_LABEL }))

    // Assert
    expect(screen.getByRole('region', { name: 'File source' })).toBeDefined()
    expect(writes()).toHaveLength(0)
  })

  it('imports several files, a DICOM study among them, as one plan in one transaction', async () => {
    // Arrange — a capture, and three files of one study: two instances of one
    // series, one of another
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act
    await userEvent.upload(screen.getByLabelText('Import file'), [
      harFile('a.har'),
      dicomFile('I1.dcm', { SeriesInstanceUID: 'S1', SeriesNumber: 1, SOPInstanceUID: 'I1' }),
      dicomFile('I2.dcm', { SeriesInstanceUID: 'S1', SeriesNumber: 1, SOPInstanceUID: 'I2' }),
      dicomFile('I3.dcm', { SeriesInstanceUID: 'S2', SeriesNumber: 2, SOPInstanceUID: 'I3' }),
    ])

    // Assert — the capture's four records, and the study's three source
    // files, Patient, ServiceRequest and one ImagingStudy
    const summary = await screen.findByRole('region', { name: 'Summary' })
    expect(within(summary).getByRole('heading').textContent).toBe('10 records from 4 files')
    expect(fileLinesIn(summary)).toEqual([
      ['a.har', '4 records · 4 new'],
      ['I1.dcm, I2.dcm, I3.dcm', '6 records · 6 new'],
    ])

    // Act
    await userEvent.click(importButton())
    await screen.findByRole('heading', { name: COMPLETE_HEADING })

    // Assert — one transaction, one ImagingStudy carrying all three
    // instances, each instance naming its own file's source file
    expect(bundleTypes()).toEqual(['batch', 'transaction'])
    const studies = writes().filter((write) => write.url.includes('/ImagingStudy/'))
    expect(studies).toHaveLength(1)
    const study = Schema.decodeUnknownSync(ImagingStudyWire)(JSON.parse(studies[0]?.body ?? ''))
    expect(study.numberOfSeries).toBe(2)
    expect(study.numberOfInstances).toBe(3)
    const sourceFileIds = writes()
      .filter((write) => write.url.includes('/DocumentReference/'))
      .map((write) => idFromUrl(write.url))
    expect(new Set(sourceFileIds).size).toBe(4)
    const instanceFileIds = study.series.flatMap((series) =>
      series.instance.map((instance) => instance.extension[0]?.valueString)
    )
    expect(new Set(instanceFileIds).size).toBe(3)
    expect(sourceFileIds).toEqual(expect.arrayContaining(instanceFileIds))
  })
})

// Helpers

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

/** The summary card's counts: each label beside the texts under it, the number first. */
const countsIn = (summary: HTMLElement): Readonly<Record<string, readonly string[]>> =>
  Object.fromEntries(
    within(summary)
      .getAllByRole('term')
      .map((term) => [
        term.textContent,
        [...(term.parentElement?.querySelectorAll('dd') ?? [])].map((dd) => dd.textContent),
      ])
  )

/** The summary card's file lines, each its title and its line. */
const fileLinesIn = (summary: HTMLElement): readonly (readonly string[])[] =>
  within(summary)
    .getAllByRole('listitem')
    .map((item) => [...item.children].map((child) => child.textContent))

/** The import bar's sentence. */
const statusLine = (): string | null =>
  within(screen.getByRole('region', { name: 'Import plan' })).getByRole('status').textContent

/** The Import button, once the plan is up. */
const findImportButton = (): Promise<HTMLButtonElement> =>
  screen.findByRole<HTMLButtonElement>('button', { name: /^Import ·/ })

/** The Import button. */
const importButton = (): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: /^Import ·/ })

const withQueryClient = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)
