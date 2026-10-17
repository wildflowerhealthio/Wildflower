import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import type Client from 'fhirclient/lib/Client'
import { describe, expect, test } from 'vite-plus/test'

import { fetchPatient, fetchPatientPage } from './patients.ts'
import { stubSmartClient } from './stub-smart-client.test-helpers.ts'

/** A searchset bundle wrapping `resources`, with no `next` link. */
const bundle = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [{ relation: 'self', url: 'https://fhir.example/Patient' }],
})

const patientWire = (id: string): unknown => ({ resourceType: 'Patient', id })

/** A client whose every request rejects with `cause`, as fhirclient's `request` rejects. */
const rejectingClient = (cause: unknown): Client =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only stub, only `request` is exercised
  ({ request: () => Promise.reject(cause) }) as unknown as Client

describe('fetchPatientPage', () => {
  test('opens the picker sorted by family name, 200 to a page', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(fetchPatientPage(client, { first: null }))

    expect(queries).toEqual(['Patient?_sort=family&_count=200'])
  })

  test('requests a later page by its cursor URL verbatim', async () => {
    const { client, queries } = stubSmartClient(bundle([]))
    const pageUrl = 'https://fhir.example/Patient?_getpages=abc&_getpagesoffset=200'

    await Effect.runPromise(fetchPatientPage(client, { pageUrl }))

    expect(queries).toEqual([pageUrl])
  })

  test('decodes returned patients and drops undecodable entries', async () => {
    const { client } = stubSmartClient(bundle([{ malformed: true }, patientWire('pat-1')]))

    const page = await Effect.runPromise(fetchPatientPage(client, { first: null }))

    expect(page.items.map((item) => item.id)).toEqual(['pat-1'])
    expect(page.nextPageUrl).toBeNull()
    expect(page.droppedEntryCount).toBe(1)
  })
})

describe('fetchPatient', () => {
  test('reads the patient by id and returns it decoded', async () => {
    const { client, queries } = stubSmartClient(patientWire('pat-1'))

    const patientRead = await Effect.runPromise(fetchPatient(client, 'pat-1'))

    expect(queries).toEqual(['Patient/pat-1'])
    expect(patientRead.kind === 'found' ? patientRead.patient.id : null).toBe('pat-1')
  })

  test('reads not-a-patient when the answer does not decode as a Patient', async () => {
    const { client } = stubSmartClient({ resourceType: 'Observation', id: 'obs-1', code: {} })

    expect(await Effect.runPromise(fetchPatient(client, 'pat-1'))).toEqual({
      kind: 'not-a-patient',
    })
  })

  test.each([404, 410])('reads missing when the server answers %i', async (status) => {
    const client = rejectingClient(Object.assign(new Error(`${status}`), { status }))

    expect(await Effect.runPromise(fetchPatient(client, 'pat-1'))).toEqual({ kind: 'missing' })
  })

  test.each([
    { case: 'another HTTP status', cause: Object.assign(new Error('500'), { status: 500 }) },
    { case: 'no response at all', cause: new TypeError('Failed to fetch') },
  ])('fails the read on $case', async ({ cause }) => {
    const failure = await Effect.runPromise(Effect.flip(fetchPatient(rejectingClient(cause), 'p')))

    expect(failure._tag).toBe('ResourcePageRequestError')
    expect(failure.cause).toBe(cause)
  })

  test('property: any patient id survives the read path as itself', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (id) => {
        const { client, queries } = stubSmartClient(patientWire('pat-1'))

        await Effect.runPromise(fetchPatient(client, id))

        // Parsed back rather than string-compared: an id carrying `/`, `?` or a
        // space must stay one path segment instead of reshaping the request.
        const [query = ''] = queries
        expect(query.startsWith('Patient/')).toBe(true)
        expect(decodeURIComponent(query.slice('Patient/'.length))).toBe(id)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
