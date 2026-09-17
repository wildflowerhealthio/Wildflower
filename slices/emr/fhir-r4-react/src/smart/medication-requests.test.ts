import { Effect, Schema } from 'effect'
import { MedicationRequest } from 'fhir-r4/resources'
import type Client from 'fhirclient/lib/Client'
import { describe, expect, test } from 'vite-plus/test'

import { fetchMedicationRequestPage } from './medication-requests.ts'
import { BundleDecodeError } from './resource-page.ts'

// A minimal, fully-specified MedicationRequest (mirrors the shell in the
// fhir-r4 resource test), encoded to valid FHIR wire so the fetch can decode
// it. The `{ malformed: true }` sibling is undecodable and must be dropped.
const sampleMedicationRequest: typeof MedicationRequest.Schema.Type = {
  resourceType: 'MedicationRequest',
  id: 'medreq-id',
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  status: 'active',
  statusReason: null,
  intent: 'order',
  category: [],
  priority: null,
  doNotPerform: null,
  reportedBoolean: null,
  reportedReference: null,
  medicationCodeableConcept: null,
  medicationReference: null,
  subject: {
    id: null,
    extension: [],
    display: null,
    identifier: null,
    reference: null,
    type: null,
  },
  encounter: null,
  supportingInformation: [],
  authoredOn: null,
  requester: null,
  performer: null,
  performerType: null,
  recorder: null,
  reasonCode: [],
  reasonReference: [],
  instantiatesCanonical: [],
  instantiatesUri: [],
  basedOn: [],
  groupIdentifier: null,
  courseOfTherapyType: null,
  insurance: [],
  note: [],
  dosageInstruction: [],
  dispenseRequest: null,
  substitution: null,
  priorPrescription: null,
  detectedIssue: [],
  eventHistory: [],
}

const sampleWire: unknown = Schema.encodeSync(MedicationRequest.Schema)(sampleMedicationRequest)

/** Build a searchset Bundle wrapping `resources`, with an optional `next` link. */
const bundle = (resources: readonly unknown[], nextUrl?: string): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [
    { relation: 'self', url: 'https://fhir.example/MedicationRequest' },
    ...(nextUrl === undefined ? [] : [{ relation: 'next', url: nextUrl }]),
  ],
})

// A stub fhirclient `Client` that records the query it was asked for and
// returns a fixed bundle. Only `request` is exercised, so the rest of the large
// `Client` surface is elided with a test-only cast.
const stubClient = (response: unknown): { readonly client: Client; readonly queries: string[] } => {
  const queries: string[] = []
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub, only `request` is exercised
  const client = {
    request: (query: string): Promise<unknown> => {
      queries.push(query)
      return Promise.resolve(response)
    },
  } as unknown as Client

  return { client, queries }
}

describe('fetchMedicationRequestPage', () => {
  test('scopes the first-page query to the patient, newest-authored first', async () => {
    const { client, queries } = stubClient(bundle([]))

    await Effect.runPromise(fetchMedicationRequestPage(client, { patientId: 'pat/1' }))

    // The patientId is URL-encoded into the `patient=` search parameter, and the
    // page is sorted server-side so scroll paging can append without reordering.
    expect(queries).toEqual(['MedicationRequest?patient=pat%2F1&_count=200&_sort=-authoredon'])
  })

  test('reads every MedicationRequest when no patient is in context (system launch)', async () => {
    const { client, queries } = stubClient(bundle([]))

    await Effect.runPromise(fetchMedicationRequestPage(client, { patientId: null }))

    expect(queries).toEqual(['MedicationRequest?_count=200&_sort=-authoredon'])
  })

  test('requests a later page by its cursor URL verbatim', async () => {
    const { client, queries } = stubClient(bundle([]))
    const pageUrl = 'https://fhir.example/MedicationRequest?_getpages=abc&_getpagesoffset=20'

    await Effect.runPromise(fetchMedicationRequestPage(client, { pageUrl }))

    // The server's own `next` link is used as-is — no re-derivation of scope/sort.
    expect(queries).toEqual([pageUrl])
  })

  test('decodes returned resources and drops undecodable entries', async () => {
    const { client } = stubClient(bundle([sampleWire, { malformed: true }]))

    const page = await Effect.runPromise(fetchMedicationRequestPage(client, { patientId: null }))

    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.id).toBe('medreq-id')
    expect(page.droppedEntryCount).toBe(1)
  })

  test('reports the next-page cursor from the bundle `next` link', async () => {
    const nextUrl = 'https://fhir.example/MedicationRequest?_getpages=abc&_getpagesoffset=20'
    const { client } = stubClient(bundle([sampleWire], nextUrl))

    const page = await Effect.runPromise(fetchMedicationRequestPage(client, { patientId: null }))

    expect(page.nextPageUrl).toBe(nextUrl)
  })

  test('reports no cursor on the last page (no `next` link)', async () => {
    const { client } = stubClient(bundle([sampleWire]))

    const page = await Effect.runPromise(fetchMedicationRequestPage(client, { patientId: null }))

    expect(page.nextPageUrl).toBeNull()
  })

  test('fails with BundleDecodeError when the response is not a bundle', async () => {
    const { client } = stubClient('not a bundle')

    const exit = await Effect.runPromiseExit(
      fetchMedicationRequestPage(client, { patientId: null })
    )

    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure') {
      const error = exit.cause._tag === 'Fail' ? exit.cause.error : undefined
      expect(error).toBeInstanceOf(BundleDecodeError)
    }
  })
})
