import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { fetchObservationBasedOnOrPartOfPage, fetchObservationPage } from './observations.ts'
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

    await Effect.runPromise(fetchObservationPage(client, { first: 'pat/1' }))

    expect(queries).toEqual(['Observation?patient=pat%2F1&_sort=date&_count=200'])
  })

  test('reads every Observation when no patient is in context (system launch)', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(fetchObservationPage(client, { first: null }))

    expect(queries).toEqual(['Observation?_sort=date&_count=200'])
  })

  test('property: any patient id survives the query as itself', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (patientId) => {
        const { client, queries } = stubSmartClient(bundle([]))

        await Effect.runPromise(fetchObservationPage(client, { first: patientId }))

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

    await Effect.runPromise(fetchObservationPage(client, { pageUrl }))

    expect(queries).toEqual([pageUrl])
  })

  test('keeps a status-less row, defaulting its status to `unknown`', async () => {
    // FHIR R4 requires `Observation.status`, but real servers omit it; the
    // schema defaults it rather than failing the row, and the page must not
    // undo that by dropping it.
    const { client } = stubSmartClient(
      bundle([{ resourceType: 'Observation', id: 'obs-1', code: {} }])
    )

    const page = await Effect.runPromise(fetchObservationPage(client, { first: null }))

    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.status).toBe('unknown')
  })

  test('drops an undecodable row without failing the page', async () => {
    const good: unknown = { resourceType: 'Observation', id: 'obs-1', status: 'final', code: {} }
    const { client } = stubSmartClient(bundle([{ malformed: true }, good]))

    const page = await Effect.runPromise(fetchObservationPage(client, { first: null }))

    expect(page.items.map((item) => item.id)).toEqual(['obs-1'])
    expect(page.droppedEntryCount).toBe(1)
  })
})

describe('fetchObservationBasedOnOrPartOfPage', () => {
  test('narrows by based-on and part-of, oldest-observed first, 200 to a page', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(
      fetchObservationBasedOnOrPartOfPage(client, {
        first: {
          patientId: 'pat/1',
          basedOnReference: 'ServiceRequest/sr-1',
          partOfReference: 'Procedure/pr-1',
        },
      })
    )

    expect(queries).toEqual([
      'Observation?patient=pat%2F1&based-on=ServiceRequest%2Fsr-1&part-of=Procedure%2Fpr-1&_sort=date&_count=200',
    ])
  })

  test('omits a reference that is not named, and the patient filter with no patient in context', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(
      fetchObservationBasedOnOrPartOfPage(client, {
        first: { patientId: null, basedOnReference: null, partOfReference: 'Procedure/pr-1' },
      })
    )

    expect(queries).toEqual(['Observation?part-of=Procedure%2Fpr-1&_sort=date&_count=200'])
  })

  test('property: any patient id and references survive the query as themselves', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string(),
        fc.option(fc.string(), { nil: null }),
        async (patientId, basedOnReference, partOfReference) => {
          const { client, queries } = stubSmartClient(bundle([]))

          await Effect.runPromise(
            fetchObservationBasedOnOrPartOfPage(client, {
              first: { patientId, basedOnReference, partOfReference },
            })
          )

          const params = searchParamsOf(queries[0] ?? '')
          expect(params.get('patient')).toBe(patientId)
          expect(params.get('based-on')).toBe(basedOnReference)
          expect(params.get('part-of')).toBe(partOfReference)
          expect(params.get('_sort')).toBe('date')
          expect(params.get('_count')).toBe('200')
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('requests a later page by its cursor URL verbatim', async () => {
    const { client, queries } = stubSmartClient(bundle([]))
    const pageUrl = 'https://fhir.example/Observation?_getpages=abc&_getpagesoffset=200'

    await Effect.runPromise(fetchObservationBasedOnOrPartOfPage(client, { pageUrl }))

    expect(queries).toEqual([pageUrl])
  })
})
