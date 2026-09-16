import { Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
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

describe('fetchPatientPage', () => {
  test('opens the picker sorted by family name, 200 to a page', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await fetchPatientPage(client, { first: null })

    expect(queries).toEqual(['Patient?_sort=family&_count=200'])
  })

  test('requests a later page by its cursor URL verbatim', async () => {
    const { client, queries } = stubSmartClient(bundle([]))
    const pageUrl = 'https://fhir.example/Patient?_getpages=abc&_getpagesoffset=200'

    await fetchPatientPage(client, { pageUrl })

    expect(queries).toEqual([pageUrl])
  })

  test('decodes returned patients and drops undecodable entries', async () => {
    const { client } = stubSmartClient(bundle([{ malformed: true }, patientWire('pat-1')]))

    const page = await fetchPatientPage(client, { first: null })

    expect(page.items.map((item) => item.id)).toEqual(['pat-1'])
    expect(page.nextPageUrl).toBeNull()
  })
})

describe('fetchPatient', () => {
  test('reads the patient by id and returns it decoded', async () => {
    const { client, queries } = stubSmartClient(patientWire('pat-1'))

    const patient = await fetchPatient(client, 'pat-1')

    expect(queries).toEqual(['Patient/pat-1'])
    expect(Option.getOrNull(patient)?.id).toBe('pat-1')
  })

  test('returns None when the answer does not decode as a Patient', async () => {
    const { client } = stubSmartClient({ resourceType: 'Observation', id: 'obs-1', code: {} })

    expect(Option.isNone(await fetchPatient(client, 'pat-1'))).toBe(true)
  })

  test('property: any patient id survives the read path as itself', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (id) => {
        const { client, queries } = stubSmartClient(patientWire('pat-1'))

        await fetchPatient(client, id)

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
