import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { fetchProcedurePage } from './procedures.ts'
import { stubSmartClient } from './stub-smart-client.test-helpers.ts'

/** A searchset bundle wrapping `resources`, with no `next` link. */
const bundle = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [{ relation: 'self', url: 'https://fhir.example/Procedure' }],
})

/** The search parameters of an issued query, parsed back off the wire. */
const searchParamsOf = (query: string): URLSearchParams =>
  new URLSearchParams(query.slice(query.indexOf('?') + 1))

const CATEGORY_TOKEN = 'https://wildflower.example/feature|strength-training'
const PLAN_DEFINITION_URL = 'https://wildflower.example/PlanDefinition/pd-1'

describe('fetchProcedurePage', () => {
  test("searches the patient's procedures of one category carrying out one definition, oldest first", async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(
      fetchProcedurePage(client, {
        first: {
          patientId: 'pat/1',
          categoryToken: CATEGORY_TOKEN,
          instantiatesCanonicalUrl: PLAN_DEFINITION_URL,
        },
      })
    )

    expect(queries).toEqual([
      `Procedure?patient=pat%2F1&category=${encodeURIComponent(CATEGORY_TOKEN)}&instantiates-canonical=${encodeURIComponent(PLAN_DEFINITION_URL)}&_sort=date&_count=200`,
    ])
  })

  test('drops the patient filter when no patient is in context (system launch)', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(
      fetchProcedurePage(client, {
        first: {
          patientId: null,
          categoryToken: CATEGORY_TOKEN,
          instantiatesCanonicalUrl: PLAN_DEFINITION_URL,
        },
      })
    )

    expect(searchParamsOf(queries[0] ?? '').has('patient')).toBe(false)
  })

  test('drops the definition filter when no canonical url is given, reading procedures of every definition', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(
      fetchProcedurePage(client, {
        first: {
          patientId: 'pat-1',
          categoryToken: CATEGORY_TOKEN,
          instantiatesCanonicalUrl: null,
        },
      })
    )

    const params = searchParamsOf(queries[0] ?? '')
    expect(params.has('instantiates-canonical')).toBe(false)
    expect(params.get('patient')).toBe('pat-1')
    expect(params.get('category')).toBe(CATEGORY_TOKEN)
  })

  test('property: any patient id, category token and canonical url (or none) survive the query as themselves', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string(),
        fc.option(fc.string(), { nil: null }),
        async (patientId, categoryToken, instantiatesCanonicalUrl) => {
          const { client, queries } = stubSmartClient(bundle([]))

          await Effect.runPromise(
            fetchProcedurePage(client, {
              first: { patientId, categoryToken, instantiatesCanonicalUrl },
            })
          )

          // Parsed back rather than string-compared: a value carrying `&`, `=`
          // or a space must arrive at the server as one parameter value.
          const params = searchParamsOf(queries[0] ?? '')
          expect(params.get('patient')).toBe(patientId)
          expect(params.get('category')).toBe(categoryToken)
          expect(params.get('instantiates-canonical')).toBe(instantiatesCanonicalUrl)
          expect(params.get('status')).toBeNull()
          expect(params.get('_sort')).toBe('date')
          expect(params.get('_count')).toBe('200')
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('requests a later page by its cursor URL verbatim', async () => {
    const { client, queries } = stubSmartClient(bundle([]))
    const pageUrl = 'https://fhir.example/Procedure?_getpages=abc&_getpagesoffset=200'

    await Effect.runPromise(fetchProcedurePage(client, { pageUrl }))

    expect(queries).toEqual([pageUrl])
  })

  test('drops an entry without an id, counting it', async () => {
    const { client } = stubSmartClient(
      bundle([
        {
          resourceType: 'Procedure',
          id: 'pr-1',
          status: 'completed',
          subject: { reference: 'Patient/pat-1' },
        },
        { resourceType: 'Procedure', status: 'completed', subject: { reference: 'Patient/pat-1' } },
      ])
    )

    const page = await Effect.runPromise(
      fetchProcedurePage(client, {
        first: {
          patientId: null,
          categoryToken: CATEGORY_TOKEN,
          instantiatesCanonicalUrl: PLAN_DEFINITION_URL,
        },
      })
    )

    expect(page.items.map((procedure) => procedure.id)).toEqual(['pr-1'])
    expect(page.droppedEntryCount).toBe(1)
  })
})
