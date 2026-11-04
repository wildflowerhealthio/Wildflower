import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { fetchActiveServiceRequestPage, fetchServiceRequestPage } from './service-requests.ts'
import { smartRuntimeAnswering, STUB_FHIR_BASE } from './test-helpers.ts'

/** A searchset bundle wrapping `resources`, with no `next` link. */
const bundle = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [{ relation: 'self', url: 'https://fhir.example/ServiceRequest' }],
})

/** The search parameters of an issued query, parsed back off the wire. */
const searchParamsOf = (query: string): URLSearchParams =>
  new URLSearchParams(query.slice(query.indexOf('?') + 1))

const CATEGORY_TOKEN = 'https://wildflower.example/feature|strength-training'
const PLAN_DEFINITION_URL = 'https://wildflower.example/PlanDefinition/pd-1'

describe('fetchActiveServiceRequestPage', () => {
  test("searches the patient's active requests of one category carrying out one definition", async () => {
    const { runtime, urls } = smartRuntimeAnswering(bundle([]))

    await Effect.runPromise(
      fetchActiveServiceRequestPage({
        first: {
          patientId: 'pat/1',
          categoryToken: CATEGORY_TOKEN,
          instantiatesCanonicalUrl: PLAN_DEFINITION_URL,
        },
      }).pipe(Effect.provide(runtime.runtimeLayer))
    )

    expect(urls).toEqual([
      `${STUB_FHIR_BASE}/ServiceRequest?patient=pat%2F1&category=${encodeURIComponent(CATEGORY_TOKEN)}&instantiates-canonical=${encodeURIComponent(PLAN_DEFINITION_URL)}&status=active&_sort=authored&_count=200`,
    ])
  })

  test('drops the patient filter when no patient is in context (system launch)', async () => {
    const { runtime, urls } = smartRuntimeAnswering(bundle([]))

    await Effect.runPromise(
      fetchActiveServiceRequestPage({
        first: {
          patientId: null,
          categoryToken: CATEGORY_TOKEN,
          instantiatesCanonicalUrl: PLAN_DEFINITION_URL,
        },
      }).pipe(Effect.provide(runtime.runtimeLayer))
    )

    expect(searchParamsOf(urls[0] ?? '').has('patient')).toBe(false)
  })

  test('drops the definition filter when no canonical url is given, reading requests of every definition', async () => {
    const { runtime, urls } = smartRuntimeAnswering(bundle([]))

    await Effect.runPromise(
      fetchActiveServiceRequestPage({
        first: {
          patientId: 'pat-1',
          categoryToken: CATEGORY_TOKEN,
          instantiatesCanonicalUrl: null,
        },
      }).pipe(Effect.provide(runtime.runtimeLayer))
    )

    const params = searchParamsOf(urls[0] ?? '')
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
          const { runtime, urls } = smartRuntimeAnswering(bundle([]))

          await Effect.runPromise(
            fetchActiveServiceRequestPage({
              first: { patientId, categoryToken, instantiatesCanonicalUrl },
            }).pipe(Effect.provide(runtime.runtimeLayer))
          )

          // Parsed back rather than string-compared: a value carrying `&`, `=`
          // or a space must arrive at the server as one parameter value.
          const params = searchParamsOf(urls[0] ?? '')
          expect(params.get('patient')).toBe(patientId)
          expect(params.get('category')).toBe(categoryToken)
          expect(params.get('instantiates-canonical')).toBe(instantiatesCanonicalUrl)
          expect(params.get('status')).toBe('active')
          expect(params.get('_sort')).toBe('authored')
          expect(params.get('_count')).toBe('200')
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('requests a later page by its cursor URL verbatim', async () => {
    const { runtime, urls } = smartRuntimeAnswering(bundle([]))
    const pageUrl = 'https://fhir.example/ServiceRequest?_getpages=abc&_getpagesoffset=200'

    await Effect.runPromise(
      fetchActiveServiceRequestPage({ pageUrl }).pipe(Effect.provide(runtime.runtimeLayer))
    )

    expect(urls).toEqual([pageUrl])
  })

  test('drops an entry without an id, counting it', async () => {
    const { runtime } = smartRuntimeAnswering(
      bundle([
        {
          resourceType: 'ServiceRequest',
          id: 'sr-1',
          status: 'active',
          intent: 'plan',
          subject: { reference: 'Patient/pat-1' },
        },
        {
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'plan',
          subject: { reference: 'Patient/pat-1' },
        },
      ])
    )

    const page = await Effect.runPromise(
      fetchActiveServiceRequestPage({
        first: {
          patientId: null,
          categoryToken: CATEGORY_TOKEN,
          instantiatesCanonicalUrl: PLAN_DEFINITION_URL,
        },
      }).pipe(Effect.provide(runtime.runtimeLayer))
    )

    expect(page.items.map((serviceRequest) => serviceRequest.id)).toEqual(['sr-1'])
    expect(page.droppedEntryCount).toBe(1)
  })
})

describe('fetchServiceRequestPage', () => {
  test("searches the patient's requests of one category carrying out one definition, in every status", async () => {
    const { runtime, urls } = smartRuntimeAnswering(bundle([]))

    await Effect.runPromise(
      fetchServiceRequestPage({
        first: {
          patientId: 'pat/1',
          categoryToken: CATEGORY_TOKEN,
          instantiatesCanonicalUrl: PLAN_DEFINITION_URL,
        },
      }).pipe(Effect.provide(runtime.runtimeLayer))
    )

    expect(urls).toEqual([
      `${STUB_FHIR_BASE}/ServiceRequest?patient=pat%2F1&category=${encodeURIComponent(CATEGORY_TOKEN)}&instantiates-canonical=${encodeURIComponent(PLAN_DEFINITION_URL)}&_sort=authored&_count=200`,
    ])
  })

  test('property: any patient id, category token and canonical url (or none) survive the query as themselves, with no status filter', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.string(), { nil: null }),
        fc.string(),
        fc.option(fc.string(), { nil: null }),
        async (patientId, categoryToken, instantiatesCanonicalUrl) => {
          const { runtime, urls } = smartRuntimeAnswering(bundle([]))

          await Effect.runPromise(
            fetchServiceRequestPage({
              first: { patientId, categoryToken, instantiatesCanonicalUrl },
            }).pipe(Effect.provide(runtime.runtimeLayer))
          )

          const params = searchParamsOf(urls[0] ?? '')
          expect(params.get('patient')).toBe(patientId)
          expect(params.get('category')).toBe(categoryToken)
          expect(params.get('instantiates-canonical')).toBe(instantiatesCanonicalUrl)
          expect(params.has('status')).toBe(false)
          expect(params.get('_sort')).toBe('authored')
          expect(params.get('_count')).toBe('200')
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('decodes a closed request beside an active one', async () => {
    const { runtime } = smartRuntimeAnswering(
      bundle(
        (['active', 'completed', 'revoked'] as const).map((status) => ({
          resourceType: 'ServiceRequest',
          id: `sr-${status}`,
          status,
          intent: 'plan',
          subject: { reference: 'Patient/pat-1' },
        }))
      )
    )

    const page = await Effect.runPromise(
      fetchServiceRequestPage({
        first: {
          patientId: 'pat-1',
          categoryToken: CATEGORY_TOKEN,
          instantiatesCanonicalUrl: null,
        },
      }).pipe(Effect.provide(runtime.runtimeLayer))
    )

    expect(page.items.map((serviceRequest) => serviceRequest.status)).toEqual([
      'active',
      'completed',
      'revoked',
    ])
    expect(page.droppedEntryCount).toBe(0)
  })
})
