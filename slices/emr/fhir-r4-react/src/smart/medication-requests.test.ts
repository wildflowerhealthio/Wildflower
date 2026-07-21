import { Schema } from 'effect'
import { MedicationRequest } from 'fhir-r4/resources'
import type Client from 'fhirclient/lib/Client'
import { describe, expect, test } from 'vite-plus/test'

import { fetchMedicationRequests } from './medication-requests.ts'

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

// A stub fhirclient `Client` that records the query it was asked for and
// returns a fixed flat list. Only `request` is exercised, so the rest of the
// large `Client` surface is elided with a test-only cast.
const stubClient = (
  response: readonly unknown[]
): { readonly client: Client; readonly queries: string[] } => {
  const queries: string[] = []
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub, only `request` is exercised
  const client = {
    request: (query: string): Promise<readonly unknown[]> => {
      queries.push(query)
      return Promise.resolve(response)
    },
  } as unknown as Client

  return { client, queries }
}

describe('fetchMedicationRequests', () => {
  test('scopes the query to the patient when a patientId is given', async () => {
    const { client, queries } = stubClient([])

    await fetchMedicationRequests(client, 'pat/1')

    // The patientId is URL-encoded into the `patient=` search parameter.
    expect(queries).toEqual(['MedicationRequest?patient=pat%2F1'])
  })

  test('reads every MedicationRequest when no patient is in context (system launch)', async () => {
    const { client, queries } = stubClient([])

    await fetchMedicationRequests(client, null)

    expect(queries).toEqual(['MedicationRequest'])
  })

  test('decodes returned resources and drops undecodable entries', async () => {
    const { client } = stubClient([sampleWire, { malformed: true }])

    const requests = await fetchMedicationRequests(client, null)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.id).toBe('medreq-id')
  })
})
