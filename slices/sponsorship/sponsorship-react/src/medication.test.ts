import { Schema } from 'effect'
import { MedicationRequest } from 'fhir-r4/resources'
import { describe, expect, test } from 'vite-plus/test'

import { medicationRequestsToMedications, medicationRequestToMedication } from './medication.ts'

const decode = Schema.decodeUnknownSync(MedicationRequest.Schema)

const base = {
  resourceType: 'MedicationRequest',
  status: 'active',
  intent: 'order',
  subject: { reference: 'Patient/1' },
}

describe('medicationRequestToMedication', () => {
  test('prefers the codeableConcept text', () => {
    const request = decode({
      ...base,
      id: 'mr1',
      authoredOn: '2024-01-02T03:04:05Z',
      medicationCodeableConcept: { text: 'Abilify 5 mg', coding: [{ display: 'aripiprazole' }] },
    })
    const med = medicationRequestToMedication(request, 'fallback')
    expect(med.id).toBe('mr1')
    expect(med.displayName).toBe('Abilify 5 mg')
    expect(med.status).toBe('active')
    expect(med.authoredOn).toBe('2024-01-02T03:04:05.000Z')
  })

  test('falls back to the first coding display', () => {
    const request = decode({
      ...base,
      medicationCodeableConcept: { coding: [{ display: 'aripiprazole' }] },
    })
    expect(medicationRequestToMedication(request, 'fallback').displayName).toBe('aripiprazole')
  })

  test('falls back to a medication reference display', () => {
    const request = decode({
      ...base,
      medicationReference: { reference: 'Medication/9', display: 'Actonel DR' },
    })
    expect(medicationRequestToMedication(request, 'fallback').displayName).toBe('Actonel DR')
  })

  test('uses the fallback id and a generic name when nothing is present', () => {
    const request = decode(base)
    const med = medicationRequestToMedication(request, 'fallback-7')
    expect(med.id).toBe('fallback-7')
    expect(med.displayName).toBe('Unknown medication')
    expect(med.authoredOn).toBeUndefined()
  })
})

describe('medicationRequestsToMedications', () => {
  test('derives positional fallback keys', () => {
    const requests = [decode(base), decode(base)]
    const meds = medicationRequestsToMedications(requests)
    expect(meds.map((m) => m.id)).toEqual(['medication-request-0', 'medication-request-1'])
  })
})
