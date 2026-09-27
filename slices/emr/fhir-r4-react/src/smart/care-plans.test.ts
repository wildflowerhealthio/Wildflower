import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { fetchCarePlanPage } from './care-plans.ts'
import { stubSmartClient } from './stub-smart-client.test-helpers.ts'

/** A searchset bundle wrapping `resources`, with no `next` link. */
const bundle = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [{ relation: 'self', url: 'https://fhir.example/CarePlan' }],
})

/** The search parameters of an issued query, parsed back off the wire. */
const searchParamsOf = (query: string): URLSearchParams =>
  new URLSearchParams(query.slice(query.indexOf('?') + 1))

/** A minimal readable `CarePlan` wire. */
const carePlanWire = (id: string): unknown => ({
  resourceType: 'CarePlan',
  id,
  status: 'active',
  intent: 'plan',
  subject: { reference: 'Patient/pat-1' },
})

describe('fetchCarePlanPage', () => {
  test("scopes the first-page query to the patient's active plans, 200 to a page", async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(
      fetchCarePlanPage(client, { first: { patientId: 'pat/1', category: null } })
    )

    expect(queries).toEqual(['CarePlan?patient=pat%2F1&status=active&_count=200'])
  })

  test('narrows the first-page query to one category token, URL-encoded', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(
      fetchCarePlanPage(client, {
        first: {
          patientId: 'pat-1',
          category: 'https://example.org/CodeSystem/plan-kind|strength-training',
        },
      })
    )

    expect(queries).toEqual([
      'CarePlan?patient=pat-1&category=https%3A%2F%2Fexample.org%2FCodeSystem%2Fplan-kind%7Cstrength-training&status=active&_count=200',
    ])
  })

  test('property: any patient id and category survive the query as themselves', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (patientId, category) => {
        const { client, queries } = stubSmartClient(bundle([]))

        await Effect.runPromise(fetchCarePlanPage(client, { first: { patientId, category } }))

        // Parsed back rather than string-compared: an id carrying `&`, `=` or a
        // space must arrive at the server as one parameter value.
        const params = searchParamsOf(queries[0] ?? '')
        expect(params.get('patient')).toBe(patientId)
        expect(params.get('category')).toBe(category)
        expect(params.get('status')).toBe('active')
        expect(params.get('_count')).toBe('200')
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('requests a later page by its cursor URL verbatim', async () => {
    const { client, queries } = stubSmartClient(bundle([]))
    const pageUrl = 'https://fhir.example/CarePlan?_getpages=abc&_getpagesoffset=200'

    await Effect.runPromise(fetchCarePlanPage(client, { pageUrl }))

    expect(queries).toEqual([pageUrl])
  })

  test('decodes each CarePlan on the page', async () => {
    const { client } = stubSmartClient(bundle([carePlanWire('plan-1'), carePlanWire('plan-2')]))

    const page = await Effect.runPromise(
      fetchCarePlanPage(client, { first: { patientId: 'pat-1', category: null } })
    )

    expect(page.items.map((item) => item.id)).toEqual(['plan-1', 'plan-2'])
    expect(page.droppedEntryCount).toBe(0)
  })

  test('drops an undecodable row without failing the page', async () => {
    const { client } = stubSmartClient(bundle([{ malformed: true }, carePlanWire('plan-1')]))

    const page = await Effect.runPromise(
      fetchCarePlanPage(client, { first: { patientId: 'pat-1', category: null } })
    )

    expect(page.items.map((item) => item.id)).toEqual(['plan-1'])
    expect(page.droppedEntryCount).toBe(1)
  })
})
