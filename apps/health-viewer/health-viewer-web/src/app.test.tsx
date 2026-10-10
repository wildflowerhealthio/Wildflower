import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type * as SmartReads from '@wildflowerhealthio/fhir-r4-react/smart'
import type { SmartHandshake } from '@wildflowerhealthio/fhir-r4-react/smart'
import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import { MedicationRequest, Observation } from '@wildflowerhealthio/fhir-r4/resources'
import {
  SERIES_PARAM,
  decodeSelection,
  readRecord,
} from '@wildflowerhealthio/health-viewer-core-js'
import { Schema } from 'effect'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { SmartClient } from './smart-client.ts'

// Only the handshake is stubbed: the page reads are the real `fhir-r4-react/smart`
// ones, issued through a stub client whose `request` answers from a table of
// FHIR responses. So decoding — an Observation, a MedicationRequest without
// its id — is exercised end to end rather than assumed.
const { handshakeMock, launchFailureRedirectMock } = vi.hoisted(() => ({
  handshakeMock: vi.fn<() => SmartHandshake>(),
  launchFailureRedirectMock: vi.fn<(handshake: SmartHandshake) => void>(),
}))
vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async (importOriginal) => {
  const actual: typeof SmartReads = await importOriginal()
  return {
    ...actual,
    useSmartHandshake: () => handshakeMock(),
    useLaunchFailureRedirect: (handshake: SmartHandshake) => {
      launchFailureRedirectMock(handshake)
    },
  }
})

const { App } = await import('./app.tsx')

/** The FHIR server behind the stub client: response by request-URL prefix. */
type FhirResponses = Readonly<Record<string, () => Promise<unknown>>>

/** A request no entry in the table answers — a test that forgot a response. */
class UnexpectedRequestError extends Error {}

/** Every URL the stub clients were asked for, in order. */
const requestedUrls: string[] = []

/** A SMART client whose reads answer from `responses`, launched with `patientId` in context. */
const stubClient = (patientId: string | null, responses: FhirResponses): SmartClient => {
  const request = (url: string): Promise<unknown> => {
    requestedUrls.push(url)
    const prefix = Object.keys(responses)
      .filter((candidate) => url.startsWith(candidate))
      .toSorted((left, right) => right.length - left.length)[0]
    const respond = prefix === undefined ? undefined : responses[prefix]
    return respond === undefined
      ? Promise.reject(new UnexpectedRequestError(`unexpected request ${url}`))
      : respond()
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub: the reads touch only `request` and `patient.id`
  return { patient: { id: patientId }, request } as unknown as SmartClient
}

/** A search-result bundle holding `resources`, pointing on to `nextUrl` when given. */
const bundleOf = (resources: readonly unknown[], nextUrl?: string): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: nextUrl === undefined ? [] : [{ relation: 'next', url: nextUrl }],
})

const answer =
  (body: unknown): (() => Promise<unknown>) =>
  () =>
    Promise.resolve(body)

/** A response that never arrives — a page still in flight. */
const pending = (): Promise<unknown> => new Promise(() => {})

/** A response that arrives when the test says, for asserting what holds before it does. */
const deferredAnswer = (
  body: unknown
): { readonly respond: () => Promise<unknown>; readonly release: () => void } => {
  let release = (): void => undefined
  const arrived = new Promise<unknown>((resolve) => {
    release = () => {
      resolve(body)
    }
  })
  return { respond: () => arrived, release: () => release() }
}

const patientWire = {
  resourceType: 'Patient',
  id: 'p1',
  name: [{ given: ['Ada'], family: 'Lovelace' }],
  birthDate: '1815-12-10',
}

const otherPatientWire = {
  resourceType: 'Patient',
  id: 'p2',
  name: [{ given: ['Grace'], family: 'Hopper' }],
  birthDate: '1906-12-09',
}

/** A laboratory reading of `code`, e.g. glucose — dated unless `dated` is `false`. */
const labWire = (
  id: string,
  code: string,
  text: string,
  dated: boolean = true
): Record<string, unknown> => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  category: [
    {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/observation-category',
          code: 'laboratory',
        },
      ],
    },
  ],
  code: { coding: [{ system: 'http://loinc.org', code }], text },
  ...(dated ? { effectiveDateTime: '2024-01-01T00:00:00Z' } : {}),
  valueQuantity: { value: 5.4, unit: 'mmol/L' },
})

const glucoseWire = labWire('obs-glucose', '2339-0', 'Glucose')
const potassiumWire = labWire('obs-potassium', '2823-3', 'Potassium')

/** An observation with no time at all: the observation source counts it as undated. */
const undatedWire = labWire('obs-undated', '2339-0', 'Glucose', false)

/** An active request for `medication` at 500 mg, authored on New Year's Day 2024. */
const medicationRequestWire = (
  id: string | undefined,
  medication: string
): Record<string, unknown> => ({
  resourceType: 'MedicationRequest',
  ...(id === undefined ? {} : { id }),
  status: 'active',
  intent: 'order',
  subject: { reference: 'Patient/p1' },
  authoredOn: '2024-01-01T00:00:00Z',
  medicationCodeableConcept: { text: medication },
  dosageInstruction: [{ doseAndRate: [{ doseQuantity: { value: 500, unit: 'mg' } }] }],
})

const metforminWire = medicationRequestWire('mr-metformin', 'Metformin 500 mg tablet')

/** The series `readRecord` files for these wire resources — ids and labels as the app will list them. */
const seriesOf = (
  observations: readonly unknown[],
  medicationRequests: readonly unknown[]
): readonly { readonly id: string; readonly label: string }[] =>
  readRecord({
    observations: observations.map((wire) => Schema.decodeUnknownSync(Observation.Schema)(wire)),
    medicationRequests: medicationRequests.map((wire) =>
      Schema.decodeUnknownSync(withMandatoryId(MedicationRequest.Schema))(wire)
    ),
  }).filed.map(({ series }) => ({ id: series.id, label: series.label }))

const [glucoseSeries] = seriesOf([glucoseWire], [])
const [potassiumSeries] = seriesOf([potassiumWire], [])
const [metforminSeries] = seriesOf([], [metforminWire])

const NEXT_OBSERVATIONS = 'https://fhir.example/next/observations'
const NEXT_MEDICATION_REQUESTS = 'https://fhir.example/next/medication-requests'

/** A launch with `p1` in context whose record holds glucose and metformin, one page each. */
const recordResponses = (overrides: FhirResponses = {}): FhirResponses => ({
  'Patient/p1': answer(patientWire),
  'Observation?': answer(bundleOf([glucoseWire])),
  'MedicationRequest?': answer(bundleOf([metforminWire])),
  ...overrides,
})

const launchWith = (client: SmartClient): void => {
  handshakeMock.mockReturnValue({ kind: 'ready', client })
}

/** Render `App` under StrictMode over a retry-free client (fast failures). */
const renderApp = (): void => {
  render(
    <StrictMode>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <App />
      </QueryClientProvider>
    </StrictMode>
  )
}

/** Text that starts with `label`, taken literally. */
const startingWith = (label: string): RegExp =>
  new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)

/** The panel row that selects the series labelled `label`. */
const seriesCheckbox = (label: string): HTMLElement =>
  screen.getByRole('checkbox', { name: startingWith(label) })

const selectionInUrl = (): ReturnType<typeof decodeSelection> =>
  decodeSelection(new URLSearchParams(window.location.search))

/** The query of each record read the app issued for `resourceType`, in order. */
const recordReadQueries = (resourceType: string): readonly URLSearchParams[] =>
  requestedUrls
    .filter((url) => url.startsWith(`${resourceType}?`))
    .map((url) => new URLSearchParams(url.slice(url.indexOf('?') + 1)))

beforeEach(() => {
  window.history.replaceState(null, '', '/health-viewer/')
  requestedUrls.length = 0
})

afterEach(() => {
  cleanup()
  handshakeMock.mockReset()
  launchFailureRedirectMock.mockReset()
})

describe('App', () => {
  it('should say Loading… while the handshake is still connecting', () => {
    // Arrange
    handshakeMock.mockReturnValue({ kind: 'connecting' })

    // Act
    renderApp()

    // Assert
    expect(screen.getByText('Loading…')).toBeDefined()
  })

  it('should surface a failed token exchange and carry it to the app root', () => {
    // Arrange
    handshakeMock.mockReturnValue({ kind: 'error', error: new Error('token exchange failed') })

    // Act
    renderApp()

    // Assert
    expect(screen.getByRole('alert').textContent).toContain('token exchange failed')
    const [carried] = launchFailureRedirectMock.mock.calls[0] ?? []
    expect(carried?.kind).toBe('error')
  })

  it('should name the patient in context under the title', async () => {
    // Arrange
    launchWith(stubClient('p1', recordResponses()))

    // Act
    renderApp()

    // Assert
    expect(await screen.findByText('Ada Lovelace · born 1815-12-10')).toBeDefined()
  })

  it('should offer a patient picker with no patient in context, and write the choice to the URL', async () => {
    // Arrange
    launchWith(
      stubClient(null, {
        ...recordResponses(),
        'Patient?': answer(bundleOf([patientWire])),
      })
    )
    renderApp()

    // Act
    fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))

    // Assert — the pick is in the URL, and that patient's record loads
    expect(new URLSearchParams(window.location.search).get('patient')).toBe('p1')
    expect(await screen.findByRole('button', { name: /Laboratory/ })).toBeDefined()
    expect(screen.getByText('Ada Lovelace · born 1815-12-10')).toBeDefined()
    expect(recordReadQueries('Observation').map((query) => query.get('patient'))).toEqual(['p1'])
  })

  it("should chart every patient's records together for All patients, read unscoped", async () => {
    // Arrange — the two series belong to different patients
    launchWith(
      stubClient(null, {
        ...recordResponses(),
        'Patient?': answer(bundleOf([patientWire, otherPatientWire])),
      })
    )
    renderApp()

    // Act
    fireEvent.click(await screen.findByRole('button', { name: /All patients/ }))

    // Assert — both reads are unscoped, the choice is in the URL and named under the title
    expect(await waitFor(() => seriesCheckbox(glucoseSeries?.label ?? ''))).toBeDefined()
    expect(seriesCheckbox(metforminSeries?.label ?? '')).toBeDefined()
    expect(new URLSearchParams(window.location.search).get('patient')).toBe('*')
    expect(screen.getByText('All patients')).toBeDefined()
    for (const resourceType of ['Observation', 'MedicationRequest']) {
      const queries = recordReadQueries(resourceType)
      expect(queries).not.toHaveLength(0)
      expect(queries.every((query) => !query.has('patient'))).toBe(true)
    }
  })

  it("should open on the launch's patient, and change to another from the picker", async () => {
    // Arrange
    launchWith(
      stubClient('p1', {
        ...recordResponses(),
        'Patient/p2': answer(otherPatientWire),
        'Patient?': answer(bundleOf([patientWire, otherPatientWire])),
      })
    )
    renderApp()
    await screen.findByText('Ada Lovelace · born 1815-12-10')

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Change patient' }))
    fireEvent.click(await screen.findByRole('button', { name: /Grace Hopper/ }))

    // Assert — the other patient's record is read, and the choice is in the URL
    expect(await screen.findByText('Grace Hopper · born 1906-12-09')).toBeDefined()
    await screen.findByRole('button', { name: /Laboratory/ })
    expect(new URLSearchParams(window.location.search).get('patient')).toBe('p2')
    expect(recordReadQueries('Observation').map((query) => query.get('patient'))).toEqual([
      'p1',
      'p2',
    ])
  })

  it("should open on the URL's patient over the launch's", async () => {
    // Arrange
    window.history.replaceState(null, '', '/health-viewer/?patient=p2')
    launchWith(
      stubClient('p1', {
        ...recordResponses(),
        'Patient/p2': answer(otherPatientWire),
      })
    )

    // Act
    renderApp()

    // Assert
    expect(await screen.findByText('Grace Hopper · born 1906-12-09')).toBeDefined()
    expect(recordReadQueries('Observation').map((query) => query.get('patient'))).toEqual(['p2'])
  })

  it('should list an observation category group and a Medications group, and plot a selected dose', async () => {
    // Arrange
    launchWith(stubClient('p1', recordResponses()))
    renderApp()
    const metforminRow = await waitFor(() => seriesCheckbox(metforminSeries?.label ?? ''))

    // Act
    fireEvent.click(metforminRow)

    // Assert — both groups are listed, and the dose is on the chart
    expect(screen.getByRole('button', { name: /Laboratory/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /Medications/ })).toBeDefined()
    const legend = screen.getByRole('list', { name: 'Series' })
    expect(within(legend).getByText(startingWith(metforminSeries?.label ?? ''))).toBeDefined()
    expect(document.querySelector('svg > g[aria-label="line"]')).not.toBeNull()
  })

  it('should say Loading more… while either read still has a next page', async () => {
    // Arrange — observations point on to a page still in flight
    launchWith(
      stubClient(
        'p1',
        recordResponses({
          'Observation?': answer(bundleOf([glucoseWire], NEXT_OBSERVATIONS)),
          [NEXT_OBSERVATIONS]: pending,
        })
      )
    )

    // Act
    renderApp()

    // Assert — the pages already in are listed while the rest load
    expect(await screen.findByText('Loading more…')).toBeDefined()
    expect(seriesCheckbox(glucoseSeries?.label ?? '')).toBeDefined()
    expect(seriesCheckbox(metforminSeries?.label ?? '')).toBeDefined()
  })

  it('should not plot a MedicationRequest without an id, and count it as unreadable', async () => {
    // Arrange
    launchWith(
      stubClient(
        'p1',
        recordResponses({
          'MedicationRequest?': answer(
            bundleOf([metforminWire, medicationRequestWire(undefined, 'Lisinopril 10 mg tablet')])
          ),
        })
      )
    )

    // Act
    renderApp()

    // Assert
    expect(await screen.findByText("1 record couldn't be read")).toBeDefined()
    expect(seriesCheckbox(metforminSeries?.label ?? '')).toBeDefined()
    expect(screen.queryByRole('checkbox', { name: /Lisinopril/ })).toBeNull()
  })

  it('should keep every loaded series listed when a later page of either read fails', async () => {
    // Arrange
    launchWith(
      stubClient(
        'p1',
        recordResponses({
          'MedicationRequest?': answer(bundleOf([metforminWire], NEXT_MEDICATION_REQUESTS)),
          [NEXT_MEDICATION_REQUESTS]: () => Promise.reject(new Error('page two failed')),
        })
      )
    )

    // Act
    renderApp()

    // Assert
    expect(await screen.findByText(/^Could not load medication requests:/)).toBeDefined()
    expect(seriesCheckbox(glucoseSeries?.label ?? '')).toBeDefined()
    expect(seriesCheckbox(metforminSeries?.label ?? '')).toBeDefined()
    expect(screen.queryByText('Loading more…')).toBeNull()
  })

  it('should replace the body when the first page of either read fails', async () => {
    // Arrange
    launchWith(
      stubClient(
        'p1',
        recordResponses({ 'Observation?': () => Promise.reject(new Error('search failed')) })
      )
    )

    // Act
    renderApp()

    // Assert
    expect(await screen.findByText(/^Could not load observations:/)).toBeDefined()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('should restore both kinds of selection and the range from the URL, and write changes back', async () => {
    // Arrange
    const params = new URLSearchParams()
    params.append(SERIES_PARAM, glucoseSeries?.id ?? '')
    params.append(SERIES_PARAM, metforminSeries?.id ?? '')
    params.set('r', '1y')
    window.history.replaceState(null, '', `/health-viewer/?${params.toString()}`)
    launchWith(stubClient('p1', recordResponses()))
    renderApp()
    const glucoseRow = await waitFor(() => seriesCheckbox(glucoseSeries?.label ?? ''))

    // Assert — restored
    expect(glucoseRow).toHaveProperty('checked', true)
    expect(seriesCheckbox(metforminSeries?.label ?? '')).toHaveProperty('checked', true)
    expect(screen.getByRole('button', { name: '1y' }).getAttribute('aria-pressed')).toBe('true')

    // Act — unselect glucose, then pick another range
    fireEvent.click(glucoseRow)
    fireEvent.click(screen.getByRole('button', { name: '90d' }))

    // Assert — the URL follows, without adding history entries
    expect(selectionInUrl()).toEqual({
      series: [metforminSeries?.id],
      range: '90d',
    })
  })

  it('should drop a selected series the record does not hold, once both reads have finished paging', async () => {
    // Arrange — potassium is a valid id this record holds no series for, and
    // the observations' second page is held back
    const secondObservationPage = deferredAnswer(bundleOf([]))
    const params = new URLSearchParams()
    params.append(SERIES_PARAM, glucoseSeries?.id ?? '')
    params.append(SERIES_PARAM, potassiumSeries?.id ?? '')
    window.history.replaceState(null, '', `/health-viewer/?${params.toString()}`)
    launchWith(
      stubClient(
        'p1',
        recordResponses({
          'Observation?': answer(bundleOf([glucoseWire], NEXT_OBSERVATIONS)),
          [NEXT_OBSERVATIONS]: secondObservationPage.respond,
        })
      )
    )
    renderApp()
    await screen.findByText('Loading more…')

    // Assert — still paging, so the id could yet be on a later page
    expect(selectionInUrl().series).toEqual([glucoseSeries?.id, potassiumSeries?.id])

    // Act
    secondObservationPage.release()

    // Assert
    await waitFor(() => {
      expect(selectionInUrl().series).toEqual([glucoseSeries?.id])
    })
    expect(screen.getByText('1 of 4 selected')).toBeDefined()
  })

  it('should say how many records were left out of the chart', async () => {
    // Arrange
    launchWith(
      stubClient(
        'p1',
        recordResponses({ 'Observation?': answer(bundleOf([glucoseWire, undatedWire])) })
      )
    )

    // Act
    renderApp()

    // Assert
    expect(await screen.findByText('1 undated record skipped')).toBeDefined()
  })
})
