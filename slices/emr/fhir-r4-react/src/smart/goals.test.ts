import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { fetchGoalPage } from './goals.ts'
import { stubSmartClient } from './stub-smart-client.test-helpers.ts'

/** A searchset bundle wrapping `resources`, with no `next` link. */
const bundle = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [{ relation: 'self', url: 'https://fhir.example/Goal' }],
})

/** The search parameters of an issued query, parsed back off the wire. */
const searchParamsOf = (query: string): URLSearchParams =>
  new URLSearchParams(query.slice(query.indexOf('?') + 1))

/** A minimal readable `Goal` wire. */
const goalWire = (id: string): unknown => ({
  resourceType: 'Goal',
  id,
  lifecycleStatus: 'active',
  description: { text: 'Squat' },
  subject: { reference: 'Patient/pat-1' },
})

describe('fetchGoalPage', () => {
  test("scopes the first-page query to the patient's goals, 200 to a page", async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(fetchGoalPage(client, { first: 'pat/1' }))

    expect(queries).toEqual(['Goal?patient=pat%2F1&_count=200'])
  })

  test('property: any patient id survives the query as itself', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (patientId) => {
        const { client, queries } = stubSmartClient(bundle([]))

        await Effect.runPromise(fetchGoalPage(client, { first: patientId }))

        // Parsed back rather than string-compared: an id carrying `&`, `=` or a
        // space must arrive at the server as one parameter value.
        const params = searchParamsOf(queries[0] ?? '')
        expect(params.get('patient')).toBe(patientId)
        expect(params.get('_count')).toBe('200')
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('requests a later page by its cursor URL verbatim', async () => {
    const { client, queries } = stubSmartClient(bundle([]))
    const pageUrl = 'https://fhir.example/Goal?_getpages=abc&_getpagesoffset=200'

    await Effect.runPromise(fetchGoalPage(client, { pageUrl }))

    expect(queries).toEqual([pageUrl])
  })

  test('decodes each Goal on the page', async () => {
    const { client } = stubSmartClient(bundle([goalWire('goal-1'), goalWire('goal-2')]))

    const page = await Effect.runPromise(fetchGoalPage(client, { first: 'pat-1' }))

    expect(page.items.map((item) => item.id)).toEqual(['goal-1', 'goal-2'])
    expect(page.droppedEntryCount).toBe(0)
  })

  test('drops an undecodable row without failing the page', async () => {
    const { client } = stubSmartClient(bundle([{ malformed: true }, goalWire('goal-1')]))

    const page = await Effect.runPromise(fetchGoalPage(client, { first: 'pat-1' }))

    expect(page.items.map((item) => item.id)).toEqual(['goal-1'])
    expect(page.droppedEntryCount).toBe(1)
  })
})
