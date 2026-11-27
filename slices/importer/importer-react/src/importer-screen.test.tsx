import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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
  CHANGED_CHIP,
  CHOOSE_OTHER_FILES_LABEL,
  COMPLETE_HEADING,
  createAllLabel,
  DECIDED_AUTOMATICALLY_HEADING,
  DONT_ADD_ANY_LABEL,
  DONT_ADD_LABEL,
  GO_TO_RECORD_LABEL,
  identifierMatchTag,
  IMPORT_MORE_FILES_LABEL,
  NO_MATCH_TAG,
  NO_RECORDS_READ_SENTENCE,
  NOT_RECOGNISED_LINE,
  NOTHING_TO_IMPORT_SENTENCE,
  onImportLabel,
  READ_FAILED_MESSAGE,
  READING_MESSAGE,
  REFUSED_MESSAGE,
  settingsNotAppliedMessage,
  TRY_AGAIN_LABEL,
  REREADING_MESSAGE,
  RESET_TO_SUGGESTED_LABEL,
  sameAsExistingLine,
  SAVE_AS_NEW_LABEL,
  setEveryLabel,
  SETTINGS_LABEL,
  SHOW_LABEL,
  UNREADABLE_LINE,
  USE_EXISTING_LABEL,
  useRecordLabel,
} from './plan/plan-text.ts'
import { formatRegistry } from './registry.ts'
import {
  type CapturedServer,
  dicomFile,
  NAMED_PATIENT_HAR,
  RECOGNIZED_HAR,
  SERVER_A,
  SERVER_B,
  storedSourceFile,
  tyraBanksHar,
} from './screen-fixtures.ts'
import {
  bundleTypes,
  clearRecorded,
  heldWireOf,
  idFromUrl,
  isResourceWrite,
  metaSourceOf,
  reads,
  type RecordedRequest,
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
/** The stubbed `scrollIntoView` (jsdom has none), re-armed each test. */
let scrollIntoView = vi.fn()
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
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // jsdom has no `scrollIntoView` of its own to put back.
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
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

  it('offers the stored Patient a capture off another server names, already selected, and writes one Patient', async () => {
    // Arrange — Tyra Banks imported off server A
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })
    await userEvent.upload(
      screen.getByLabelText('Import file'),
      harOf(tyraBanksHar(SERVER_A), 'a.har')
    )
    await userEvent.click(await findImportButton())
    await userEvent.click(await screen.findByRole('button', { name: IMPORT_MORE_FILES_LABEL }))
    const [storedPatient] = resourceWrites('Patient')
    const firstImport = writes().length

    // Act — her capture off server B, which names her under another id
    await userEvent.upload(
      screen.getByLabelText('Import file'),
      harOf(tyraBanksHar(SERVER_B), 'b.har')
    )

    // Assert — the stored Patient is a probable match, already selected
    const card = await findDecisionCard('Select a Patient record for Tyra Banks from b.har')
    expect(
      within(card).getByText('1 possible match · referenced by 2 records · same name, birthDate')
    ).toBeDefined()
    const useStored = within(card).getByRole<HTMLInputElement>('radio', {
      name: USE_EXISTING_LABEL,
    })
    expect(useStored.checked).toBe(true)
    expect(within(card).getByText('probable match')).toBeDefined()
    expect(within(card).getByText('2 records will reference this record instead.')).toBeDefined()

    // Act
    await userEvent.click(importButton())
    await screen.findByRole('heading', { name: COMPLETE_HEADING })

    // Assert — one Patient, the stored one, carrying both servers' identifiers,
    // and both of B's Observations naming it
    const written = writes().slice(firstImport).filter(isResourceWrite)
    const patients = written.filter((write) => write.url.includes('/Patient/'))
    expect(patients.map((write) => write.url)).toEqual([`/Patient/${storedPatient?.id ?? ''}`])
    expect(heldWireOf(JSON.parse(patients[0]?.body ?? '')).identifier).toEqual([
      { system: `${SERVER_A.baseUrl}/Patient`, value: SERVER_A.patientId },
      { system: `${SERVER_B.baseUrl}/Patient`, value: SERVER_B.patientId },
    ])
    expect(subjectsOf(written)).toEqual([
      subjectNaming(SERVER_B, `Patient/${storedPatient?.id ?? ''}`),
      subjectNaming(SERVER_B, `Patient/${storedPatient?.id ?? ''}`),
    ])
  })

  describe('with two stored namesakes', () => {
    beforeEach(() => {
      currentRunAuthed = routingServer({
        stored: [namesake('s-1', '2025-02-11T09:30:00Z'), namesake('s-2', '2026-06-02T14:00:00Z')],
      })
    })

    it('leaves the Patient not selected, blocks the import, and goes to its card', async () => {
      // Arrange
      render(<ImporterScreen />, { wrapper: withQueryClient })

      // Act
      await userEvent.upload(
        screen.getByLabelText('Import file'),
        harOf(tyraBanksHar(SERVER_A), 'a.har')
      )

      // Assert
      const card = await findDecisionCard('Select a Patient record for Tyra Banks from a.har')
      expect(
        within(card).getByText(
          'Not selected · 2 possible matches · referenced by 2 records · same name, birthDate'
        )
      ).toBeDefined()
      expect(
        within(card)
          .getAllByRole<HTMLInputElement>('radio')
          .map((radio) => radio.checked)
      ).toEqual([false, false, false, false])
      expect(importButton().disabled).toBe(true)

      // Act
      await userEvent.click(screen.getByRole('button', { name: GO_TO_RECORD_LABEL }))

      // Assert — the card scrolled to, its first radio focused
      expect(scrollIntoView.mock.contexts).toEqual([card])
      expect(document.activeElement).toBe(
        within(card).getByRole('radio', { name: SAVE_AS_NEW_LABEL })
      )
    })

    it('writes the import onto the namesake chosen', async () => {
      // Arrange
      render(<ImporterScreen />, { wrapper: withQueryClient })
      await userEvent.upload(
        screen.getByLabelText('Import file'),
        harOf(tyraBanksHar(SERVER_A), 'a.har')
      )
      const card = await findDecisionCard('Select a Patient record for Tyra Banks from a.har')

      // Act
      await userEvent.click(
        within(card).getByRole('radio', {
          name: USE_EXISTING_LABEL,
          description: /updated 2026-06-02/u,
        })
      )

      // Assert
      expect(importButton().disabled).toBe(false)

      // Act
      await userEvent.click(importButton())
      await screen.findByRole('heading', { name: COMPLETE_HEADING })

      // Assert
      const written = writes().filter(isResourceWrite)
      expect(
        written.filter((write) => write.url.includes('/Patient/')).map((write) => write.url)
      ).toEqual(['/Patient/s-2'])
      expect(subjectsOf(written)).toEqual([
        subjectNaming(SERVER_A, 'Patient/s-2'),
        subjectNaming(SERVER_A, 'Patient/s-2'),
      ])
    })

    it('writes a new Patient when it is saved as a new record', async () => {
      // Arrange
      render(<ImporterScreen />, { wrapper: withQueryClient })
      await userEvent.upload(
        screen.getByLabelText('Import file'),
        harOf(tyraBanksHar(SERVER_A), 'a.har')
      )
      const card = await findDecisionCard('Select a Patient record for Tyra Banks from a.har')

      // Act
      await userEvent.click(within(card).getByRole('radio', { name: SAVE_AS_NEW_LABEL }))
      await userEvent.click(importButton())
      await screen.findByRole('heading', { name: COMPLETE_HEADING })

      // Assert — one Patient under neither namesake's id, both Observations naming it
      const written = writes().filter(isResourceWrite)
      const patients = written.filter((write) => write.url.includes('/Patient/'))
      expect(patients).toHaveLength(1)
      const newPatient = `Patient/${idFromUrl(patients[0]?.url ?? '')}`
      expect(['Patient/s-1', 'Patient/s-2']).not.toContain(newPatient)
      expect(subjectsOf(written)).toEqual([
        subjectNaming(SERVER_A, newPatient),
        subjectNaming(SERVER_A, newPatient),
      ])
    })

    it('writes no Patient when it is not added, and its Observations keep her name with no reference', async () => {
      // Arrange
      render(<ImporterScreen />, { wrapper: withQueryClient })
      await userEvent.upload(
        screen.getByLabelText('Import file'),
        harOf(tyraBanksHar(SERVER_A), 'a.har')
      )
      const card = await findDecisionCard('Select a Patient record for Tyra Banks from a.har')

      // Act
      await userEvent.click(within(card).getByRole('radio', { name: DONT_ADD_LABEL }))

      // Assert
      expect(
        within(card).getByText('· 2 records keep the display “Tyra Banks” with no reference')
      ).toBeDefined()

      // Act
      await userEvent.click(importButton())
      await screen.findByRole('heading', { name: COMPLETE_HEADING })

      // Assert — the Observations alone, each naming her by display and identifier only
      const written = writes().filter(isResourceWrite)
      expect(written.map((write) => write.url.split('/')[1])).toEqual([
        'Observation',
        'Observation',
      ])
      const { reference: _reference, ...unlinked } = subjectNaming(SERVER_A, '')
      expect(subjectsOf(written)).toEqual([unlinked, unlinked])
    })
  })

  it('takes every differing field, then none, with the stored Patient’s update checkbox', async () => {
    // Arrange — a stored Tyra Banks with a phone number and no gender; the
    // capture gives her a gender (a gap) and another phone number (an overwrite)
    currentRunAuthed = routingServer({
      stored: [
        {
          ...namesake('s-1', '2026-06-02T14:00:00Z'),
          telecom: [{ system: 'phone', value: '555-0100' }],
        },
      ],
    })
    render(<ImporterScreen />, { wrapper: withQueryClient })
    await userEvent.upload(
      screen.getByLabelText('Import file'),
      harOf(
        tyraBanksHar(SERVER_A, {
          gender: 'female',
          telecom: [{ system: 'phone', value: '555-0199' }],
        }),
        'a.har'
      )
    )
    const card = await findDecisionCard('Select a Patient record for Tyra Banks from a.har')

    // Assert — the gap is filled and the overwrite is not: partly checked
    const update = (): HTMLInputElement =>
      within(card).getByRole<HTMLInputElement>('checkbox', { name: /^Update with import details/u })
    expect(update().labels?.[0]?.textContent).toBe('Update with import details · 1 of 2')
    expect([update().checked, update().indeterminate]).toEqual([false, true])
    expect(
      within(card).getByText('2 records will reference this record instead, with 1 field updated.')
    ).toBeDefined()

    // Act
    await userEvent.click(update())

    // Assert — every field taken
    expect(update().labels?.[0]?.textContent).toBe('Update with import details · 2 of 2')
    expect([update().checked, update().indeterminate]).toEqual([true, false])
    expect(
      within(card).getByText('2 records will reference this record instead, with 2 fields updated.')
    ).toBeDefined()

    // Act
    await userEvent.click(update())

    // Assert — none taken: a link
    expect(update().labels?.[0]?.textContent).toBe('Update with import details · 0 of 2')
    expect([update().checked, update().indeterminate]).toEqual([false, false])
    expect(within(card).getByText('2 records will reference this record instead.')).toBeDefined()
  })

  it('disables every choice on a card while the transaction is in flight', async () => {
    // Arrange — a stored Tyra Banks the capture differs from, and a server
    // that holds the transaction until released
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    currentRunAuthed = routingServer({
      stored: [
        {
          ...namesake('s-1', '2026-06-02T14:00:00Z'),
          telecom: [{ system: 'phone', value: '555-0100' }],
        },
      ],
      transactionsHeldUntil: held,
    })
    render(<ImporterScreen />, { wrapper: withQueryClient })
    await userEvent.upload(
      screen.getByLabelText('Import file'),
      harOf(tyraBanksHar(SERVER_A, { gender: 'female' }), 'a.har')
    )
    const card = await findDecisionCard('Select a Patient record for Tyra Banks from a.har')

    // Act
    await userEvent.click(importButton())

    // Assert — every radio and the checkbox disabled, and a click changes nothing
    const controls = [
      ...within(card).getAllByRole<HTMLInputElement>('radio'),
      within(card).getByRole<HTMLInputElement>('checkbox'),
    ]
    expect(controls.map((control) => control.matches(':disabled'))).toEqual([
      true,
      true,
      true,
      true,
    ])
    await userEvent.click(within(card).getByText('Save as a new record'))
    expect(
      within(card)
        .getAllByRole<HTMLInputElement>('radio')
        .map((radio) => radio.checked)
    ).toEqual([false, true, false])

    // Act
    release()

    // Assert
    await screen.findByRole('heading', { name: COMPLETE_HEADING })
  })

  it('keeps a refused write said while the reviewer changes a choice', async () => {
    // Arrange — a stored Tyra Banks, and a server that refuses the first transaction
    let refusals = 0
    currentRunAuthed = routingServer({
      stored: [namesake('s-1', '2026-06-02T14:00:00Z')],
      failWrite: (request) => {
        if (refusals > 0 || !request.url.includes('/DocumentReference/')) return false
        refusals += 1
        return true
      },
    })
    render(<ImporterScreen />, { wrapper: withQueryClient })
    await userEvent.upload(
      screen.getByLabelText('Import file'),
      harOf(tyraBanksHar(SERVER_A), 'a.har')
    )
    const card = await findDecisionCard('Select a Patient record for Tyra Banks from a.har')
    await userEvent.click(importButton())
    await screen.findByRole('alert')

    // Act
    await userEvent.click(within(card).getByRole('radio', { name: SAVE_AS_NEW_LABEL }))

    // Assert
    expect(within(screen.getByRole('alert')).getByText(REFUSED_MESSAGE)).toBeDefined()

    // Act — import again
    await userEvent.click(importButton())

    // Assert
    await screen.findByRole('heading', { name: COMPLETE_HEADING })
    expect(screen.queryByRole('alert')).toBeNull()
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

  it('shows the loader card while the files are read', async () => {
    // Arrange — the plan's runner never answers, so the read stays in flight
    currentRunAuthed = routingServer({})
    currentRunPlan = () => new Promise<never>(() => {})
    render(<ImporterScreen />, { wrapper: withQueryClient })

    // Act
    await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))

    // Assert
    expect(within(await screen.findByRole('status')).getByText(READING_MESSAGE)).toBeDefined()
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

  describe('Decided automatically', () => {
    it('folds every record of a capture already imported behind the same as existing line, and writes nothing', async () => {
      // Arrange — import the capture once, then choose it again
      currentRunAuthed = routingServer({})
      render(<ImporterScreen />, { wrapper: withQueryClient })
      await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
      await userEvent.click(await findImportButton())
      await userEvent.click(await screen.findByRole('button', { name: IMPORT_MORE_FILES_LABEL }))
      const written = writes().length

      // Act
      await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))

      // Assert — no row listed, each group folded
      const decided = await screen.findByRole('region', { name: DECIDED_AUTOMATICALLY_HEADING })
      expect(within(decided).queryAllByRole('combobox')).toEqual([])
      const folds = within(decided).getAllByRole('button', { name: /same as existing/u })
      expect(folds.map((fold) => fold.textContent)).toEqual([
        sameAsExistingLine(1) + SHOW_LABEL,
        sameAsExistingLine(1) + SHOW_LABEL,
        sameAsExistingLine(2) + SHOW_LABEL,
      ])

      // Act
      const [patientFold, sourceFileFold, observationsFold] = folds
      await userEvent.click(patientFold ?? document.body)
      await userEvent.click(sourceFileFold ?? document.body)
      await userEvent.click(observationsFold ?? document.body)

      // Assert — every record's row, each the same as its existing record
      expect(
        within(decided)
          .getAllByRole('combobox')
          .map((choice) => rowTextOf(choice)[2])
      ).toEqual([
        `portal-session.har · ${identifierMatchTag(0)} · referenced by 2 records`,
        identifierMatchTag(0),
        identifierMatchTag(0),
        identifierMatchTag(0),
      ])
      expect(folds.map((fold) => fold.getAttribute('aria-expanded'))).toEqual([
        'true',
        'true',
        'true',
      ])
      expect(screen.queryByRole('button', { name: /^Import ·/u })).toBeNull()
      expect(writes()).toHaveLength(written)
    })

    it('marks a row changed to Don’t add, moves the counts, says its referrers keep the display only, and resets it', async () => {
      // Arrange
      currentRunAuthed = routingServer({})
      render(<ImporterScreen />, { wrapper: withQueryClient })
      await userEvent.upload(
        screen.getByLabelText('Import file'),
        harOf(tyraBanksHar(SERVER_A), 'a.har')
      )
      const tyra = await findRowChoice('Tyra Banks')
      expect(rowTextOf(tyra)).toEqual([
        'Tyra Banks',
        '1990-01-02',
        `a.har · ${NO_MATCH_TAG} · referenced by 2 records`,
      ])

      // Act
      await userEvent.selectOptions(tyra, DONT_ADD_LABEL)

      // Assert — the row changed, the counts moved, the Observations name her by display only
      expect(rowTextOf(tyra)[0]).toBe(`Tyra Banks${CHANGED_CHIP}`)
      const summary = screen.getByRole('region', { name: 'Summary' })
      expect(countsIn(summary)['Create']).toEqual(['3'])
      expect(fileLinesIn(summary)).toEqual([['a.har', '4 records · 3 new · 1 not added']])
      const observations = groupOf('Observation')
      expect(
        within(observations)
          .getAllByText(/^subject:/u)
          .map((detail) => detail.textContent)
      ).toEqual(['subject: Tyra Banks (display only)', 'subject: Tyra Banks (display only)'])

      // Act
      await userEvent.click(within(rowOf(tyra)).getByRole('button', { name: 'Reset' }))

      // Assert
      expect(rowTextOf(tyra)[0]).toBe('Tyra Banks')
      expect(within(rowOf(tyra)).queryByRole('button', { name: 'Reset' })).toBeNull()
      expect(tyra.value).toBe('save-as-new')
      expect(fileLinesIn(summary)).toEqual([['a.har', '4 records · 4 new']])
      expect(
        within(observations)
          .getAllByText(/^subject:/u)
          .map((detail) => detail.textContent)
      ).toEqual(['subject: Tyra Banks', 'subject: Tyra Banks'])
    })

    it('adds none of a group with Don’t add any, resets it, and writes it anew with Create all', async () => {
      // Arrange — the capture imported once, then chosen again
      currentRunAuthed = routingServer({})
      render(<ImporterScreen />, { wrapper: withQueryClient })
      await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
      await userEvent.click(await findImportButton())
      await userEvent.click(await screen.findByRole('button', { name: IMPORT_MORE_FILES_LABEL }))
      const storedObservations = resourceWrites('Observation').map(({ id }) => id)
      await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
      await screen.findByRole('heading', { name: /^Observation ·/u })
      const observations = groupOf('Observation')
      const summary = screen.getByRole('region', { name: 'Summary' })

      // Act
      await chooseFromGroupMenu(observations, 'Observation', DONT_ADD_ANY_LABEL)

      // Assert — both listed and changed, none folded
      expect(fileLinesIn(summary)).toEqual([
        ['portal-session.har', '4 records · 2 linked · 2 not added'],
      ])
      expect(
        within(observations)
          .getAllByRole<HTMLSelectElement>('combobox')
          .map((choice) => choice.value)
      ).toEqual(['dont-add', 'dont-add'])
      expect(within(observations).getAllByText(CHANGED_CHIP)).toHaveLength(2)
      expect(within(observations).queryByRole('button', { name: /same as existing/u })).toBeNull()

      // Act
      await chooseFromGroupMenu(observations, 'Observation', RESET_TO_SUGGESTED_LABEL)

      // Assert — folded again
      expect(fileLinesIn(summary)).toEqual([['portal-session.har', '4 records · 4 linked']])
      expect(within(observations).queryAllByRole('combobox')).toEqual([])

      // Act
      await chooseFromGroupMenu(observations, 'Observation', createAllLabel(2))
      await userEvent.click(importButton())
      await screen.findByRole('heading', { name: COMPLETE_HEADING })

      // Assert — two new Observations, neither under a stored one's id
      expect(screen.getByRole('status').textContent).toBe(
        `✓Success: 2 new, 0 updated, 2 linked. ${IMPORT_MORE_FILES_LABEL}`
      )
      const rewritten = resourceWrites('Observation').slice(storedObservations.length)
      expect(rewritten).toHaveLength(2)
      expect(rewritten.map(({ id }) => storedObservations.includes(id))).toEqual([false, false])
    })

    it('keeps focus on a folded row’s choice when it is changed, and moves it to the choice on Reset', async () => {
      // Arrange — the capture imported once, then chosen again, its Observations unfolded
      currentRunAuthed = routingServer({})
      render(<ImporterScreen />, { wrapper: withQueryClient })
      await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
      await userEvent.click(await findImportButton())
      await userEvent.click(await screen.findByRole('button', { name: IMPORT_MORE_FILES_LABEL }))
      await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
      await screen.findByRole('heading', { name: /^Observation ·/u })
      const observations = groupOf('Observation')
      await userEvent.click(within(observations).getByRole('button', { name: /same as existing/u }))
      const [, second] = within(observations).getAllByRole<HTMLSelectElement>('combobox')
      if (second === undefined) throw new Error('Two Observation rows are shown')

      // Act
      await userEvent.selectOptions(second, DONT_ADD_LABEL)

      // Assert — listed first now, changed, and still focused
      expect(within(observations).getAllByRole('combobox')[0]).toBe(second)
      expect(document.activeElement).toBe(second)

      // Act
      await userEvent.click(within(rowOf(second)).getByRole('button', { name: 'Reset' }))

      // Assert
      expect(second.value).toBe('existing-0')
      expect(document.activeElement).toBe(second)
    })

    it('says an identifier match whose field differs, offers its update selected, and writes it', async () => {
      // Arrange — a stored Tyra Banks carrying her identifier off server A,
      // with no gender; the capture gives her one
      currentRunAuthed = routingServer({
        stored: [
          {
            ...namesake('s-1', '2026-06-02T14:00:00Z'),
            identifier: [{ system: `${SERVER_A.baseUrl}/Patient`, value: SERVER_A.patientId }],
          },
        ],
      })
      render(<ImporterScreen />, { wrapper: withQueryClient })

      // Act
      await userEvent.upload(
        screen.getByLabelText('Import file'),
        harOf(tyraBanksHar(SERVER_A, { gender: 'female' }), 'a.har')
      )

      // Assert
      const tyra = await findRowChoice('Tyra Banks')
      expect(rowTextOf(tyra)).toEqual([
        'Tyra Banks',
        '1990-01-02 · female',
        `a.har · ${identifierMatchTag(1)} · referenced by 2 records`,
      ])
      expect(identifierMatchTag(1)).toBe('Identifier match · 1 field differs')
      expect(tyra.selectedOptions[0]?.textContent).toBe(
        useRecordLabel({ title: 'Tyra Banks', updates: true })
      )

      // Act
      await userEvent.click(importButton())
      await screen.findByRole('heading', { name: COMPLETE_HEADING })

      // Assert — the stored Patient written with her gender
      const patients = writes().filter((write) => write.url.includes('/Patient/'))
      expect(patients.map((write) => write.url)).toEqual(['/Patient/s-1'])
      expect(JSON.parse(patients[0]?.body ?? '')).toMatchObject({ id: 's-1', gender: 'female' })
    })

    it('disables every row and group menu while the transaction is in flight', async () => {
      // Arrange — a server that holds the transaction until released
      let release = (): void => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      currentRunAuthed = routingServer({ transactionsHeldUntil: held })
      render(<ImporterScreen />, { wrapper: withQueryClient })
      await userEvent.upload(screen.getByLabelText('Import file'), harFile('portal-session.har'))
      const decided = await screen.findByRole('region', { name: DECIDED_AUTOMATICALLY_HEADING })

      // Act
      await userEvent.click(importButton())

      // Assert
      const controls = [
        ...within(decided).getAllByRole('combobox'),
        ...within(decided).getAllByRole('button', { name: /^Set every/u }),
      ]
      expect(controls).toHaveLength(6)
      expect(controls.every((control) => control.matches(':disabled'))).toBe(true)

      // Act
      release()

      // Assert
      await screen.findByRole('heading', { name: COMPLETE_HEADING })
    })
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

  describe('Settings', () => {
    it('reads a DICOM study again when its time zone changes, Import waiting while it does, keeping the field, its focus and the capture’s choices, and writes the plan read again', async () => {
      // Arrange — a capture and a study, Tyra Banks set to Don't add
      currentRunAuthed = routingServer({})
      let planRunner: RunAuthed = currentRunAuthed
      currentRunPlan = (effect, options) => planRunner(effect, options)
      render(<ImporterScreen />, { wrapper: withQueryClient })
      await userEvent.upload(screen.getByLabelText('Import file'), [
        harOf(tyraBanksHar(SERVER_A), 'a.har'),
        dicomFile('I1.dcm', STUDY_AT_NOON),
      ])
      const tyra = await findRowChoice('Tyra Banks')
      await userEvent.selectOptions(tyra, DONT_ADD_LABEL)
      const study = screen.getByRole('region', { name: 'DICOM image I1.dcm' })
      const zoneInput = await openZoneField(study)
      let releaseReread = (): void => {}
      const rereadHeld = new Promise<void>((resolve) => {
        releaseReread = resolve
      })
      planRunner = (effect, options) => rereadHeld.then(() => currentRunAuthed(effect, options))

      // Act
      await userEvent.clear(zoneInput)
      await userEvent.type(zoneInput, `${CHATHAM}{Enter}`)

      // Assert — the plan read before stays, Import waits, the field keeps its focus
      expect(statusLine()).toBe(REREADING_MESSAGE)
      expect(importButton().disabled).toBe(true)
      expect(document.activeElement).toBe(zoneInput)
      expect(settingsSummaryOf(study)).toBe(`${SETTINGS_LABEL}${CHATHAM}`)

      // Act
      releaseReread()

      // Assert — the plan read again is up under the same field, still focused,
      // and the capture's row keeps its element and its Don't add
      await waitFor(() => {
        expect(statusLine()).not.toBe(REREADING_MESSAGE)
      })
      expect(within(study).getByLabelText('Equipment time zone')).toBe(zoneInput)
      expect(document.activeElement).toBe(zoneInput)
      expect(zoneInput.value).toBe(CHATHAM)
      expect(await findRowChoice('Tyra Banks')).toBe(tyra)
      expect([rowTextOf(tyra)[0], tyra.value]).toEqual([`Tyra Banks${CHANGED_CHIP}`, 'dont-add'])
      expect(importButton().disabled).toBe(false)

      // Act
      planRunner = currentRunAuthed
      await userEvent.click(importButton())
      await screen.findByRole('heading', { name: COMPLETE_HEADING })

      // Assert — the study started at noon on Chatham's clock, and Tyra is not written
      expect(writtenStudies().map(({ started }) => started)).toEqual([STARTED_AT_NOON_IN_CHATHAM])
      expect(resourceWrites('Patient').map(({ identifier }) => identifier[0]?.value)).toEqual([
        'P001',
      ])
    })

    it('keeps a choice made while the files are read again', async () => {
      // Arrange — a capture and a study, the study's read again held
      currentRunAuthed = routingServer({})
      let planRunner: RunAuthed = currentRunAuthed
      currentRunPlan = (effect, options) => planRunner(effect, options)
      render(<ImporterScreen />, { wrapper: withQueryClient })
      await userEvent.upload(screen.getByLabelText('Import file'), [
        harOf(tyraBanksHar(SERVER_A), 'a.har'),
        dicomFile('I1.dcm', STUDY_AT_NOON),
      ])
      const tyra = await findRowChoice('Tyra Banks')
      const zoneInput = await openZoneField(
        screen.getByRole('region', { name: 'DICOM image I1.dcm' })
      )
      let releaseReread = (): void => {}
      const rereadHeld = new Promise<void>((resolve) => {
        releaseReread = resolve
      })
      planRunner = (effect, options) => rereadHeld.then(() => currentRunAuthed(effect, options))
      await userEvent.clear(zoneInput)
      await userEvent.type(zoneInput, `${CHATHAM}{Enter}`)

      // Act — Don't add Tyra Banks while the study is read again, then let it land
      await userEvent.selectOptions(tyra, DONT_ADD_LABEL)
      releaseReread()
      await waitFor(() => {
        expect(statusLine()).not.toBe(REREADING_MESSAGE)
      })

      // Assert
      expect([rowTextOf(tyra)[0], tyra.value]).toEqual([`Tyra Banks${CHANGED_CHIP}`, 'dont-add'])
    })

    it('drops a field a merge took once it no longer differs from the existing record, and keeps the time zone for the next files', async () => {
      // Arrange — the study imported once on Chatham's clock, then stored
      // twice, so it needs a decision when it is picked again
      currentRunAuthed = routingServer({})
      render(<ImporterScreen />, { wrapper: withQueryClient })
      await userEvent.upload(
        screen.getByLabelText('Import file'),
        dicomFile('I1.dcm', STUDY_AT_NOON)
      )
      await setTimeZone('DICOM image I1.dcm', CHATHAM)
      await userEvent.click(await findImportButton())
      await screen.findByRole('heading', { name: COMPLETE_HEADING })
      const written = writes()
        .filter(({ method }) => method === 'PUT')
        .map(({ body }): unknown => JSON.parse(body))
      const [writtenStudy] = writtenStudies()
      currentRunAuthed = routingServer({
        stored: [...written, { ...writtenStudy?.wire, id: 'study-copy' }],
      })
      await userEvent.click(screen.getByRole('button', { name: IMPORT_MORE_FILES_LABEL }))
      await userEvent.upload(
        screen.getByLabelText('Import file'),
        dicomFile('I1.dcm', STUDY_AT_NOON)
      )
      const card = await screen.findByRole('region', { name: /^Select an ImagingStudy record/u })
      const summary = screen.getByRole('region', { name: 'Summary' })

      // Assert — the next files were read on Chatham's clock
      expect(settingsSummaryOf(screen.getByRole('region', { name: 'DICOM image I1.dcm' }))).toBe(
        `${SETTINGS_LABEL}${CHATHAM}`
      )

      // Act — use the first stored study, read the study on another clock,
      // and take its start
      const [firstStored] = within(card).getAllByRole<HTMLInputElement>('radio', {
        name: USE_EXISTING_LABEL,
      })
      await userEvent.click(firstStored ?? document.body)
      await setTimeZone('DICOM image I1.dcm', OTHER_ZONE)
      await userEvent.click(
        within(card).getByRole('checkbox', { name: /^Update with import details/u })
      )

      // Assert
      expect(countsIn(summary)['Update']).toEqual(['1'])

      // Act — back on Chatham's clock, where the start is the stored one's
      await setTimeZone('DICOM image I1.dcm', CHATHAM)

      // Assert — the merge takes nothing: a link, written as nothing
      expect(firstStored?.checked).toBe(true)
      expect(
        within(card).queryByRole('checkbox', { name: /^Update with import details/u })
      ).toBeNull()
      expect(countsIn(summary)['Update']).toEqual(['0'])
    })

    it('shows every DICOM study the time zone one changes, applying to each', async () => {
      // Arrange — two studies
      currentRunAuthed = routingServer({})
      render(<ImporterScreen />, { wrapper: withQueryClient })
      await userEvent.upload(screen.getByLabelText('Import file'), [
        dicomFile('I1.dcm', STUDY_AT_NOON),
        dicomFile('J1.dcm', { ...STUDY_AT_NOON, StudyInstanceUID: '1.2.3.4.6' }),
      ])
      const first = await screen.findByRole('region', { name: 'DICOM image I1.dcm' })
      const second = screen.getByRole('region', { name: 'DICOM image J1.dcm' })
      const firstZone = await openZoneField(first)
      const secondZone = await openZoneField(second)

      // Act
      await setTimeZone('DICOM image I1.dcm', CHATHAM)

      // Assert — both sections say it, the second's field shows it, the first keeps its focus
      expect([settingsSummaryOf(first), settingsSummaryOf(second)]).toEqual([
        `${SETTINGS_LABEL}${CHATHAM} · for every DICOM image in this import`,
        `${SETTINGS_LABEL}${CHATHAM} · for every DICOM image in this import`,
      ])
      expect(within(second).getByLabelText<HTMLInputElement>('Equipment time zone').value).toBe(
        CHATHAM
      )
      expect(within(first).getByLabelText('Equipment time zone')).toBe(firstZone)
      expect(document.activeElement).toBe(firstZone)
      expect(secondZone.isConnected).toBe(false)
    })

    it('keeps the plan and says once, above the import bar, that the settings were not applied when the search of the read again fails', async () => {
      // Arrange
      currentRunAuthed = routingServer({})
      let planRunner: RunAuthed = currentRunAuthed
      currentRunPlan = (effect, options) => planRunner(effect, options)
      render(<ImporterScreen />, { wrapper: withQueryClient })
      await userEvent.upload(
        screen.getByLabelText('Import file'),
        dicomFile('I1.dcm', STUDY_AT_NOON)
      )
      const study = await screen.findByRole('region', { name: 'DICOM image I1.dcm' })
      const zoneInput = await openZoneField(study)
      planRunner = routingServer({ failSearches: true })

      // Act
      await userEvent.clear(zoneInput)
      await userEvent.type(zoneInput, `${CHATHAM}{Enter}`)

      // Assert — one notice, above Import and not in the Settings, the field
      // as typed and focused, Import back
      const notice = await screen.findByRole('alert')
      expect(notice.textContent).toBe(`⚠Error: ${NOT_APPLIED_TO_STUDY} ${TRY_AGAIN_LABEL}`)
      expect(screen.getAllByRole('alert')).toEqual([notice])
      expect(study.contains(notice)).toBe(false)
      expect(notice.compareDocumentPosition(importButton())).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect([zoneInput.value, document.activeElement]).toEqual([CHATHAM, zoneInput])
      expect(importButton().disabled).toBe(false)

      // Act
      planRunner = currentRunAuthed
      await userEvent.click(importButton())
      await screen.findByRole('heading', { name: COMPLETE_HEADING })

      // Assert — the plan read before is written
      expect(writtenStudies().map(({ started }) => started)).not.toContain(
        STARTED_AT_NOON_IN_CHATHAM
      )
      expect(writtenStudies()).toHaveLength(1)
    })

    it('still says the settings were not applied after a write fails, and reads again with Try again, writing the plan read again', async () => {
      // Arrange — a read again that fails, then a write the server refuses
      currentRunAuthed = routingServer({})
      let planRunner: RunAuthed = currentRunAuthed
      currentRunPlan = (effect, options) => planRunner(effect, options)
      render(<ImporterScreen />, { wrapper: withQueryClient })
      await userEvent.upload(
        screen.getByLabelText('Import file'),
        dicomFile('I1.dcm', STUDY_AT_NOON)
      )
      const zoneInput = await openZoneField(
        await screen.findByRole('region', { name: 'DICOM image I1.dcm' })
      )
      planRunner = routingServer({ failSearches: true })
      await userEvent.clear(zoneInput)
      await userEvent.type(zoneInput, `${CHATHAM}{Enter}`)
      await screen.findByText(NOT_APPLIED_TO_STUDY)
      planRunner = routingServer({ failWrite: () => true })

      // Act
      await userEvent.click(importButton())

      // Assert — the refusal said, and the settings still not applied
      expect(await screen.findByText(REFUSED_MESSAGE)).toBeDefined()
      expect(screen.getByText(NOT_APPLIED_TO_STUDY)).toBeDefined()

      // Act
      planRunner = currentRunAuthed
      await userEvent.click(screen.getByRole('button', { name: TRY_AGAIN_LABEL }))
      await waitFor(() => {
        expect(screen.queryByText(NOT_APPLIED_TO_STUDY)).toBeNull()
      })
      await userEvent.click(importButton())
      await screen.findByRole('heading', { name: COMPLETE_HEADING })

      // Assert — the plan read again is written
      expect(writtenStudies().map(({ started }) => started)).toEqual([STARTED_AT_NOON_IN_CHATHAM])
    })

    it('shows a study’s decode notes in its section, before its Settings, and no Settings for a capture', async () => {
      // Arrange
      currentRunAuthed = routingServer({})
      render(<ImporterScreen />, { wrapper: withQueryClient })

      // Act
      await userEvent.upload(screen.getByLabelText('Import file'), [
        harFile('a.har'),
        dicomFile('I1.dcm', { SeriesInstanceUID: 'S1', SeriesNumber: 1, SOPInstanceUID: 'I1' }),
        dicomFile('I2.dcm', { SeriesInstanceUID: 'S1', SeriesNumber: 1, SOPInstanceUID: 'I2' }),
      ])

      // Assert
      const study = await screen.findByRole('region', { name: 'DICOM image I1.dcm, I2.dcm' })
      const notes = within(study).getByText('I1.dcm: series 1, instance I1.').closest('ul')
      expect([...(notes?.children ?? [])].map((note) => note.textContent)).toEqual([
        'I1.dcm: series 1, instance I1.',
        'I2.dcm: series 1, instance I2.',
      ])
      expect(
        notes?.compareDocumentPosition(within(study).getByText(SETTINGS_LABEL)) ===
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBe(true)
      const capture = screen.getByRole('region', { name: 'HAR archive a.har' })
      expect(within(capture).queryByText(SETTINGS_LABEL)).toBeNull()
    })
  })
})

// Helpers

/** The study's tags a DICOM file of the canonical study states: begun on 2 January 2026 at noon by its equipment's clock. */
const STUDY_AT_NOON = {
  SeriesInstanceUID: 'S1',
  SeriesNumber: 1,
  SOPInstanceUID: 'I1',
  StudyDate: '20260102',
  StudyTime: '120000',
}

/** What the page says when the DICOM study's new settings were not applied. */
const NOT_APPLIED_TO_STUDY = settingsNotAppliedMessage(['DICOM image'])

/** A time zone 13:45 ahead of UTC in January. */
const CHATHAM = 'Pacific/Chatham'

/** A time zone other than {@link CHATHAM}: any but it does. */
const OTHER_ZONE = 'America/Toronto'

/** When the study begun at noon by a clock set to {@link CHATHAM} began. */
const STARTED_AT_NOON_IN_CHATHAM = '2026-01-01T22:15:00.000Z'

/** Just enough of a written `ImagingStudy` to read when it started. */
const StartedWire = Schema.Struct({ started: Schema.optional(Schema.String) })

/** Each written `ImagingStudy`, its wire beside when it started. */
const writtenStudies = (): readonly {
  readonly wire: object
  readonly started: string | undefined
}[] =>
  writes()
    .filter((write) => write.url.includes('/ImagingStudy/'))
    .map((write) => {
      const wire = Schema.decodeUnknownSync(Schema.Object)(JSON.parse(write.body))
      return { wire, started: Schema.decodeUnknownSync(StartedWire)(wire).started }
    })

/** The text of the summary of `section`'s Settings: "Settings" and what they say. */
const settingsSummaryOf = (section: HTMLElement): string | null =>
  within(section).getByText(SETTINGS_LABEL).closest('summary')?.textContent ?? null

/** `section`'s Settings opened, and its equipment time zone field. */
const openZoneField = async (section: HTMLElement): Promise<HTMLInputElement> => {
  const details = within(section).getByText(SETTINGS_LABEL).closest('details')
  if (details === null) throw new Error('Settings are a details element')
  if (!details.open) await userEvent.click(within(section).getByText(SETTINGS_LABEL))
  expect(details.open).toBe(true)
  return within(section).getByLabelText<HTMLInputElement>('Equipment time zone')
}

/** The time zone of the section named `sectionName` set to `timeZone`, once the plan read again under it is up. */
const setTimeZone = async (sectionName: string, timeZone: string): Promise<void> => {
  const zoneInput = await openZoneField(screen.getByRole('region', { name: sectionName }))
  await userEvent.clear(zoneInput)
  await userEvent.type(zoneInput, `${timeZone}{Enter}`)
  await waitFor(() => {
    expect(statusLine()).not.toBe(REREADING_MESSAGE)
  })
}

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

/** `har` as a `File` named `name`, for the OS-picker (`upload`) path. */
const harOf = (har: string, name: string): File =>
  new File([har], name, { type: 'application/json' })

/** A stored Tyra Banks, born 1990-01-02, under `id`, last updated at `lastUpdated`. */
const namesake = (id: string, lastUpdated: string): Record<string, unknown> => ({
  resourceType: 'Patient',
  id,
  meta: { lastUpdated },
  name: [{ family: 'Banks', given: ['Tyra'] }],
  birthDate: '1990-01-02',
})

/** The choice of the row of Decided automatically titled `title`, once the plan is up. */
const findRowChoice = (title: string): Promise<HTMLSelectElement> =>
  screen.findByRole<HTMLSelectElement>('combobox', { name: onImportLabel(title) })

/** The group of Decided automatically of `resourceType`: its heading's nearest ancestor holding its rows. */
const groupOf = (resourceType: string): HTMLElement => {
  let group: HTMLElement | null = screen.getByRole('heading', {
    name: new RegExp(`^${resourceType} ·`, 'u'),
  })
  while (group !== null && group.querySelector('ul') === null) group = group.parentElement
  if (group === null) throw new Error(`A ${resourceType} group holds its rows in a list`)
  return group
}

/** The list item of the row `choice` is the choice of. */
const rowOf = (choice: HTMLElement): HTMLElement => {
  const row = choice.closest('li')
  if (row === null) throw new Error('A row’s choice sits in a list item')
  return row
}

/** The three lines of the row `choice` is the choice of: title (with its chips), detail, reason. */
const rowTextOf = (choice: HTMLElement): readonly (string | null)[] =>
  [...(rowOf(choice).querySelector('div > div')?.children ?? [])].map((line) => line.textContent)

/** Pick `item` off the menu of the group of `resourceType`, within `group`. */
const chooseFromGroupMenu = async (
  group: HTMLElement,
  resourceType: string,
  item: string
): Promise<void> => {
  await userEvent.click(within(group).getByRole('button', { name: setEveryLabel(resourceType) }))
  await userEvent.click(within(group).getByRole('menuitem', { name: item }))
}

/** The Needs a decision card titled `title`, once the plan is up. */
const findDecisionCard = (title: string): Promise<HTMLElement> =>
  screen.findByRole('region', { name: title })

/** Just enough of a written resource to read its `subject`. */
const SubjectWire = Schema.Struct({
  subject: Schema.Struct({
    reference: Schema.optional(Schema.String),
    display: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
    identifier: Schema.optional(Schema.Struct({ system: Schema.String, value: Schema.String })),
  }),
})

/** The `subject` of each written Observation of `written`, in order. */
const subjectsOf = (
  written: readonly RecordedRequest[]
): readonly (typeof SubjectWire.Type)['subject'][] =>
  written
    .filter((write) => write.url.includes('/Observation/'))
    .map((write) => Schema.decodeUnknownSync(SubjectWire)(JSON.parse(write.body)).subject)

/**
 * The `subject` an Observation of Tyra Banks's capture off `server` is
 * written with once it lands on `reference`: her name, the identifier the
 * capture names her by, and the literal reference.
 */
const subjectNaming = (
  server: CapturedServer,
  reference: string
): (typeof SubjectWire.Type)['subject'] => ({
  reference,
  display: 'Tyra Banks',
  type: 'Patient',
  identifier: { system: `${server.baseUrl}/Patient`, value: server.patientId },
})

/** The stored resources of `resourceType` written so far, each its id and identifiers. */
const resourceWrites = (resourceType: string): readonly ReturnType<typeof heldWireOf>[] =>
  writes()
    .filter((write) => write.url.includes(`/${resourceType}/`))
    .map((write) => heldWireOf(JSON.parse(write.body)))

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
