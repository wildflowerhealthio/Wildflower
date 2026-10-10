import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { fetchDocumentReferencePage } from './document-references.ts'
import { stubSmartClient } from './stub-smart-client.test-helpers.ts'

/** A searchset bundle wrapping `resources`, with no `next` link. */
const bundle = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [{ relation: 'self', url: 'https://fhir.example/DocumentReference' }],
})

/** The search parameters of an issued query, parsed back off the wire. */
const searchParamsOf = (query: string): URLSearchParams =>
  new URLSearchParams(query.slice(query.indexOf('?') + 1))

/** A minimal valid DocumentReference on the wire. */
const documentReferenceWire = (id: string): unknown => ({
  resourceType: 'DocumentReference',
  id,
  status: 'current',
  content: [{ attachment: {} }],
})

describe('fetchDocumentReferencePage', () => {
  test('scopes the first-page query to patient and category, newest first, 200 to a page', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(
      fetchDocumentReferencePage(client, {
        first: { patientId: 'pat/1', category: 'sys|code' },
      })
    )

    expect(queries).toEqual([
      'DocumentReference?patient=pat%2F1&category=sys%7Ccode&_sort=-date&_count=200',
    ])
  })

  test('omits patient filter when patientId is null', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(
      fetchDocumentReferencePage(client, {
        first: { patientId: null, category: 'sys|code' },
      })
    )

    const params = searchParamsOf(queries[0] ?? '')
    expect(params.has('patient')).toBe(false)
    expect(params.get('category')).toBe('sys|code')
    expect(params.get('_sort')).toBe('-date')
    expect(params.get('_count')).toBe('200')
  })

  test('omits category filter when category is null', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(
      fetchDocumentReferencePage(client, {
        first: { patientId: 'pat-1', category: null },
      })
    )

    const params = searchParamsOf(queries[0] ?? '')
    expect(params.get('patient')).toBe('pat-1')
    expect(params.has('category')).toBe(false)
    expect(params.get('_sort')).toBe('-date')
  })

  test('reads all DocumentReferences when both filters are null', async () => {
    const { client, queries } = stubSmartClient(bundle([]))

    await Effect.runPromise(
      fetchDocumentReferencePage(client, {
        first: { patientId: null, category: null },
      })
    )

    expect(queries).toEqual(['DocumentReference?_sort=-date&_count=200'])
  })

  test('requests a later page by its cursor URL verbatim', async () => {
    const { client, queries } = stubSmartClient(bundle([]))
    const pageUrl = 'https://fhir.example/DocumentReference?_getpages=abc&_getpagesoffset=200'

    await Effect.runPromise(fetchDocumentReferencePage(client, { pageUrl }))

    expect(queries).toEqual([pageUrl])
  })

  test('decodes returned DocumentReferences and drops undecodable entries', async () => {
    const { client } = stubSmartClient(
      bundle([{ malformed: true }, documentReferenceWire('doc-1')])
    )

    const page = await Effect.runPromise(
      fetchDocumentReferencePage(client, {
        first: { patientId: null, category: null },
      })
    )

    expect(page.items.map((item) => item.id)).toEqual(['doc-1'])
    expect(page.droppedEntryCount).toBe(1)
  })

  test('property: any patient id survives the query as itself', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (patientId) => {
        const { client, queries } = stubSmartClient(bundle([]))

        await Effect.runPromise(
          fetchDocumentReferencePage(client, {
            first: { patientId, category: null },
          })
        )

        const params = searchParamsOf(queries[0] ?? '')
        expect(params.get('patient')).toBe(patientId)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: any category token survives the query as itself', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (category) => {
        const { client, queries } = stubSmartClient(bundle([]))

        await Effect.runPromise(
          fetchDocumentReferencePage(client, {
            first: { patientId: null, category },
          })
        )

        const params = searchParamsOf(queries[0] ?? '')
        expect(params.get('category')).toBe(category)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
