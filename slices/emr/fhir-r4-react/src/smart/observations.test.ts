import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { fetchObservationPage } from './observations.ts'
import { stubSmartClient } from './stub-smart-client.test-helpers.ts'

/** A searchset bundle wrapping `resources`, with no `next` link. */
const bundle = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [{ relation: 'self', url: 'https://fhir.example/Observation' }],
})

/** The search parameters of an issued query, parsed back off the wire. */
const searchParamsOf = (query: string): URLSearchParams =>
  new URLSearchParams(query.slice(query.indexOf('?') + 1))

describe('fetchObservationPage', () => {
  test('scopes the first-page query to the patient, oldest-observed first, 200 to a page', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await fetchObservationPage(client, { first: 'pat/1' })

    expect(queries).toEqual(['Observation?patient=pat%2F1&_sort=date&_count=200'])
  })

  test('reads every Observation when no patient is in context (system launch)', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await fetchObservationPage(client, { first: null })

    expect(queries).toEqual(['Observation?_sort=date&_count=200'])
  })

  test('property: any patient id survives the query as itself', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (patientId) => {
        const { client, queries } = stubSmartClient(bundle([]))

        await fetchObservationPage(client, { first: patientId })

        // Parsed back rather than string-compared: an id carrying `&`, `=` or a
        // space must arrive at the server as one parameter value, not as extra
        // search parameters.
        const params = searchParamsOf(queries[0] ?? '')
        expect(params.get('patient')).toBe(patientId)
        expect(params.get('_sort')).toBe('date')
        expect(params.get('_count')).toBe('200')
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('requests a later page by its cursor URL verbatim', async () => {
    const { client, queries } = stubSmartClient(bundle([]))
    const pageUrl = 'https://fhir.example/Observation?_getpages=abc&_getpagesoffset=200'

    await fetchObservationPage(client, { pageUrl })

    expect(queries).toEqual([pageUrl])
  })

  test('keeps a status-less row, defaulting its status to `unknown`', async () => {
    // FHIR R4 requires `Observation.status`, but real servers omit it; the
    // schema defaults it rather than failing the row, and the page must not
    // undo that by dropping it.
    const { client } = stubSmartClient(
      bundle([{ resourceType: 'Observation', id: 'obs-1', code: {} }])
    )

    const page = await fetchObservationPage(client, { first: null })

    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.status).toBe('unknown')
  })

  test('drops an undecodable row without failing the page', async () => {
    const good: unknown = { resourceType: 'Observation', id: 'obs-1', status: 'final', code: {} }
    const { client } = stubSmartClient(bundle([{ malformed: true }, good]))

    const page = await fetchObservationPage(client, { first: null })

    expect(page.items.map((item) => item.id)).toEqual(['obs-1'])
  })
})
