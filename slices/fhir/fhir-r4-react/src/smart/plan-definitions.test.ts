import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { fetchPlanDefinitionPage } from './plan-definitions.ts'
import { stubSmartClient } from './stub-smart-client.test-helpers.ts'

/** A searchset bundle wrapping `resources`, with no `next` link. */
const bundle = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [{ relation: 'self', url: 'https://fhir.example/PlanDefinition' }],
})

/** The search parameters of an issued query, parsed back off the wire. */
const searchParamsOf = (query: string): URLSearchParams =>
  new URLSearchParams(query.slice(query.indexOf('?') + 1))

const TOPIC_TOKEN = 'https://wildflower.example/feature|strength-training'

describe('fetchPlanDefinitionPage', () => {
  test('searches by topic, 200 to a page', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(fetchPlanDefinitionPage(client, { first: { topicToken: TOPIC_TOKEN } }))

    expect(queries).toEqual([`PlanDefinition?topic=${encodeURIComponent(TOPIC_TOKEN)}&_count=200`])
  })

  test('property: any topic token survives the query as itself', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (topicToken) => {
        const { client, queries } = stubSmartClient(bundle([]))

        await Effect.runPromise(fetchPlanDefinitionPage(client, { first: { topicToken } }))

        // Parsed back rather than string-compared: a token carrying `&`, `=` or
        // a space must arrive at the server as one parameter value.
        const params = searchParamsOf(queries[0] ?? '')
        expect(params.get('topic')).toBe(topicToken)
        expect(params.get('_count')).toBe('200')
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('requests a later page by its cursor URL verbatim', async () => {
    const { client, queries } = stubSmartClient(bundle([]))
    const pageUrl = 'https://fhir.example/PlanDefinition?_getpages=abc&_getpagesoffset=200'

    await Effect.runPromise(fetchPlanDefinitionPage(client, { pageUrl }))

    expect(queries).toEqual([pageUrl])
  })

  test('drops an entry without an id, counting it', async () => {
    const { client } = stubSmartClient(
      bundle([
        { resourceType: 'PlanDefinition', id: 'pd-1', status: 'active' },
        { resourceType: 'PlanDefinition', status: 'active' },
      ])
    )

    const page = await Effect.runPromise(
      fetchPlanDefinitionPage(client, { first: { topicToken: TOPIC_TOKEN } })
    )

    expect(page.items.map((planDefinition) => planDefinition.id)).toEqual(['pd-1'])
    expect(page.droppedEntryCount).toBe(1)
  })
})
