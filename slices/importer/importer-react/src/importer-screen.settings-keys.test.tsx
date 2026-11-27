import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { RunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import type * as FhirR4React from '@wildflowerhealthio/fhir-r4-react'
import type * as FhirR4Smart from '@wildflowerhealthio/fhir-r4-react/smart'
import type { RunSmart } from '@wildflowerhealthio/fhir-r4-react/smart'
import { FhirResourceSchema } from '@wildflowerhealthio/fhir-r4/resources'
import {
  DecodedFileSet,
  DecodeFunction,
  type ImportedCopy,
  Section,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, Option, Schema } from 'effect'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { ImporterScreen } from './importer-screen.tsx'
import {
  choicesNotKeptLine,
  DONT_ADD_LABEL,
  onImportLabel,
  REREADING_MESSAGE,
  SAVE_AS_NEW_LABEL,
  SETTINGS_LABEL,
} from './plan/plan-text.ts'
import type * as Registry from './registry.ts'
import { dicomFile } from './screen-fixtures.ts'
import { clearRecorded, routingServer } from './screen-server.test-helpers.ts'

/**
 * The import plan page when a settings change changes a record's key, as the
 * LifeLabs health card province changes a Patient's identifier: the
 * reviewer's choice on it is not kept, and the page says so. No real format
 * a jsdom test can read does that, so the DICOM decode is replaced by one
 * that reads each file as one Patient keyed by the equipment time zone and
 * one Observation keyed by the file, through the real import stage, page
 * hook and settings picker.
 */

vi.mock('./registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Registry>()
  return {
    ...actual,
    formatRegistry: {
      ...actual.formatRegistry,
      dicom: { ...actual.formatRegistry.dicom, decode: decodeKeyedByZone() },
    },
  }
})

vi.mock('@wildflowerhealthio/fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunAuthed }
})

vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4Smart>()
  return { ...actual, useRunSmart: (): RunSmart => currentRunAuthed }
})

let currentRunAuthed: RunSmart
let queryClient: QueryClient

/** A resource of the wire `fields` as a decode yields it: detached, with no id. */
const detached = (fields: object): ImportedCopy.Type['resource'] => ({
  ...Schema.decodeUnknownSync(FhirResourceSchema)({ id: 'detached', ...fields }),
  id: null,
})

/**
 * A DICOM decode keying each file's Patient by the equipment time zone. A
 * function declaration, so the hoisted registry mock can call it.
 */
function decodeKeyedByZone(): DecodeFunction.Type<{ readonly timeZone: string }, 'dicom'> {
  return DecodeFunction.make({
    format: 'dicom',
    decodeFileSet: ([file], settings: { readonly timeZone: string }) =>
      Effect.succeed({
        pickedFiles: [DecodedFileSet.unidentified(file)],
        sectionedList: SectionedList.make([
          Section.make('records', [
            {
              localKey: 'patient',
              resource: detached({
                resourceType: 'Patient',
                identifier: [{ system: 'https://zone.example/id', value: settings.timeZone }],
                name: [{ text: 'Zone Patient' }],
              }),
              sourceUrl: Option.none(),
            },
            {
              localKey: 'observation',
              resource: detached({
                resourceType: 'Observation',
                identifier: [{ system: 'https://zone.example/obs', value: file.fileName }],
                status: 'final',
                code: { text: 'Zone reading' },
              }),
              sourceUrl: Option.none(),
            },
          ]),
        ]),
        notes: [],
      }),
  })
}

beforeEach(() => {
  clearRecorded()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.restoreAllMocks()
})

describe('ImporterScreen, a settings change that changes a record’s key', () => {
  it('says the choices it could not keep above the import bar, until the next choice', async () => {
    // Arrange — the Patient and the Observation not added
    currentRunAuthed = routingServer({})
    render(<ImporterScreen />, { wrapper: withQueryClient })
    await userEvent.upload(screen.getByLabelText('Import file'), dicomFile('I1.dcm', {}))
    const patient = await screen.findByRole<HTMLSelectElement>('combobox', {
      name: onImportLabel('Zone Patient'),
    })
    const observation = screen.getByRole<HTMLSelectElement>('combobox', {
      name: onImportLabel('Zone reading'),
    })
    await userEvent.selectOptions(patient, DONT_ADD_LABEL)
    await userEvent.selectOptions(observation, DONT_ADD_LABEL)

    // Act — another time zone, which keys the Patient anew
    const section = screen.getByRole('region', { name: 'DICOM image I1.dcm' })
    await userEvent.click(within(section).getByText(SETTINGS_LABEL))
    const zoneInput = within(section).getByLabelText('Equipment time zone')
    await userEvent.clear(zoneInput)
    await userEvent.type(zoneInput, 'Pacific/Chatham{Enter}')
    await waitFor(() => {
      expect(statusLine()).not.toBe(REREADING_MESSAGE)
    })

    // Assert — the Patient's choice is gone and said, the Observation's kept
    expect(screen.getByText(choicesNotKeptLine(1))).toBeDefined()
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: onImportLabel('Zone Patient') }).value
    ).toBe('save-as-new')
    expect(observation.value).toBe('dont-add')

    // Act
    await userEvent.selectOptions(observation, SAVE_AS_NEW_LABEL)

    // Assert
    expect(screen.queryByText(choicesNotKeptLine(1))).toBeNull()
  })
})

/** The import bar's sentence. */
const statusLine = (): string | null =>
  within(screen.getByRole('region', { name: 'Import plan' })).getByRole('status').textContent

const withQueryClient = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)
