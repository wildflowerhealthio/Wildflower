import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { fetchPatient, fetchPatientPage } from './patients.ts'
import { BundleDecodeError, ResourcePageRequestError } from './resource-page.ts'
import { FhirHttpError, FhirRequestDropped, type SmartClient } from './smart-client.ts'
import {
  answerEveryRequest,
  answerStatus,
  dropRequest,
  smartClientAnswering,
  stubSmartClient,
  STUB_FHIR_BASE,
  type StubAnswer,
} from './test-helpers.ts'

/** A searchset bundle wrapping `resources`, with no `next` link. */
const bundle = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [{ relation: 'self', url: 'https://fhir.example/Patient' }],
})

const patientWire = (id: string): unknown => ({ resourceType: 'Patient', id })

/** A client whose server answers every request with `answer`. */
const failingClient = (answer: StubAnswer): SmartClient =>
  stubSmartClient(answerEveryRequest(answer)).client

describe('fetchPatientPage', () => {
  test('opens the picker sorted by family name, 200 to a page', async () => {
    const { client, urls } = smartClientAnswering(bundle([]))

    await Effect.runPromise(fetchPatientPage(client, { first: null }))

    expect(urls).toEqual([`${STUB_FHIR_BASE}/Patient?_sort=family&_count=200`])
  })

  test('requests a later page by its cursor URL verbatim', async () => {
    const { client, urls } = smartClientAnswering(bundle([]))
    const pageUrl = 'https://fhir.example/Patient?_getpages=abc&_getpagesoffset=200'

    await Effect.runPromise(fetchPatientPage(client, { pageUrl }))

    expect(urls).toEqual([pageUrl])
  })

  test('decodes returned patients and drops undecodable entries', async () => {
    const { client } = smartClientAnswering(bundle([{ malformed: true }, patientWire('pat-1')]))

    const page = await Effect.runPromise(fetchPatientPage(client, { first: null }))

    expect(page.items.map((item) => item.id)).toEqual(['pat-1'])
    expect(page.nextPageUrl).toBeNull()
    expect(page.droppedEntryCount).toBe(1)
  })
})

describe('fetchPatient', () => {
  test('reads the patient by id and returns it decoded', async () => {
    const { client, urls } = smartClientAnswering(patientWire('pat-1'))

    const patient = await Effect.runPromise(fetchPatient(client, 'pat-1'))

    expect(urls).toEqual([`${STUB_FHIR_BASE}/Patient/pat-1`])
    expect(Option.map(patient, ({ id }) => id)).toEqual(Option.some('pat-1'))
  })

  test('fails the read when the answer does not decode as a Patient', async () => {
    const answer = { resourceType: 'Observation', id: 'obs-1', code: {} }
    const { client } = smartClientAnswering(answer)

    const failure = await Effect.runPromise(Effect.flip(fetchPatient(client, 'pat-1')))

    expect(failure).toBeInstanceOf(BundleDecodeError)
    expect(failure instanceof BundleDecodeError ? failure.response : null).toEqual(answer)
  })

  test.each([404, 410])('reads no patient when the server answers %i', async (status) => {
    const client = failingClient(answerStatus(status))

    expect(await Effect.runPromise(fetchPatient(client, 'pat-1'))).toEqual(Option.none())
  })

  test.each([
    { case: 'another HTTP status', answer: answerStatus(500), failure: FhirHttpError },
    { case: 'no response at all', answer: dropRequest, failure: FhirRequestDropped },
  ])('fails the read on $case', async ({ answer, failure: expectedCause }) => {
    const failure = await Effect.runPromise(Effect.flip(fetchPatient(failingClient(answer), 'p')))

    expect(failure).toBeInstanceOf(ResourcePageRequestError)
    expect(failure.cause).toBeInstanceOf(expectedCause)
    expect(failure.cause).toMatchObject({ url: `${STUB_FHIR_BASE}/Patient/p` })
  })

  test('property: any patient id survives the read path as itself', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (id) => {
        const { client, urls } = smartClientAnswering(patientWire('pat-1'))

        await Effect.runPromise(fetchPatient(client, id))

        // Parsed back rather than string-compared: an id carrying `/`, `?` or a
        // space must stay one path segment instead of reshaping the request.
        const [url = ''] = urls
        const patientPath = `${STUB_FHIR_BASE}/Patient/`
        expect(url.startsWith(patientPath)).toBe(true)
        expect(decodeURIComponent(url.slice(patientPath.length))).toBe(id)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
