import * as fc from 'fast-check'
import { WildflowerExtension } from 'fhir-r4/data-types'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import {
  hasRefill,
  medicationRequestsToMedications,
  medicationRequestToMedication,
  medicationRequestToMedicationView,
} from './medication-view.ts'
import { base, decode, rexallRequest } from './test-helpers.ts'

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

  test('uses the fallback id and a generic name when nothing is present', () => {
    const med = medicationRequestToMedication(decode(base), 'fallback-7')
    expect(med.id).toBe('fallback-7')
    expect(med.displayName).toBe('Unknown medication')
    expect(med.authoredOn).toBeUndefined()
  })
})

describe('medicationRequestsToMedications', () => {
  test('derives positional fallback keys', () => {
    const meds = medicationRequestsToMedications([decode(base), decode(base)])
    expect(meds.map((m) => m.id)).toEqual(['medication-request-0', 'medication-request-1'])
  })
})

describe('medicationRequestToMedicationView', () => {
  test('extracts DIN, description, prescriber, note and both repeat counts', () => {
    const view = medicationRequestToMedicationView(decode(rexallRequest), 'fallback')
    expect(view.medication.displayName).toBe('Atorvastatin 20 mg tablet')
    expect(view.din).toBe('02241497')
    expect(view.description).toBe('20 mg - Tablet')
    expect(view.requester).toBe('Dr. Jane Smith')
    expect(view.note).toBe('Take with food')
    expect(view.repeatsAllowed).toBe(3)
    // `valueInteger: 0` is a real value, not "missing".
    expect(view.repeatsAvailable).toBe(0)
    // No `expectedSupplyDuration` on this request → no next-fill estimate.
    expect(view.nextFillDate).toBeNull()
  })

  test('leaves every field null when the request carries none of them', () => {
    const view = medicationRequestToMedicationView(decode(base), 'fallback')
    expect(view.din).toBeNull()
    expect(view.description).toBeNull()
    expect(view.requester).toBeNull()
    expect(view.note).toBeNull()
    expect(view.repeatsAllowed).toBeNull()
    expect(view.repeatsAvailable).toBeNull()
    expect(view.nextFillDate).toBeNull()
    expect(view.storeLink).toBeNull()
  })
})

describe('hasRefill', () => {
  it('should be true only when repeats are allowed and at least one remains', () => {
    fc.assert(
      fc.property(fc.option(fc.nat(5)), fc.option(fc.nat(5)), (allowed, available) => {
        const view = medicationRequestToMedicationView(
          decode({
            ...base,
            dispenseRequest: {
              ...(allowed === null ? {} : { numberOfRepeatsAllowed: allowed }),
              extension:
                available === null
                  ? []
                  : [{ url: WildflowerExtension.RepeatsAvailable, valueInteger: available }],
            },
          }),
          'fallback'
        )
        expect(hasRefill(view)).toBe((allowed ?? 0) > 0 && (available ?? 0) > 0)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
