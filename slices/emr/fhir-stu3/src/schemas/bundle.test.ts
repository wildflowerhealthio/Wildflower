import { Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import detailBundle from '../fixtures/detail-bundle.json' with { type: 'json' }
import listBundle from '../fixtures/list-bundle.json' with { type: 'json' }
import * as Bundle from './bundle.ts'

describe('Stu3 searchset Bundle decode', () => {
  test('decodes the captured list bundle (MedicationRequests with contained Medication)', () => {
    const decoded = Schema.decodeUnknownSync(Bundle.MedicationRequestBundle)(listBundle)

    expect(decoded.type).toBe('searchset')
    expect(decoded.total).toBe(2)
    expect(decoded.link.map((l) => l.relation)).toEqual(['self', 'next'])
    expect(decoded.entry).toHaveLength(2)

    const first = decoded.entry[0]?.resource
    expect(first?.resourceType).toBe('MedicationRequest')
    expect(first?.id).toBe('mr-0001')
    // STU3 requester.agent survives decode with the physician display intact.
    expect(first?.requester?.agent.display).toBe('Dr. Jane Smith')
    // Unknown carebook extension URL is not dropped on decode.
    expect(first?.extension.map((e) => e.url)).toContain(
      'http://example.org/unknown-future-extension'
    )
    // Contained Medication is preserved (kept as raw JSON in `contained`).
    expect(first?.contained).toHaveLength(1)
    // Carebook number-of-repeats-available rides on the dispenseRequest modifierExtension.
    expect(first?.dispenseRequest?.modifierExtension.map((e) => e.url)).toContain(
      'http://schemas.carebook.com/v1/fhir/number-of-repeats-available'
    )
    expect(first?.dispenseRequest?.numberOfRepeatsAllowed).toBe(3)
  })

  test('decodes the captured detail bundle (mixed MedicationRequest + MedicationDispense)', () => {
    const decoded = Schema.decodeUnknownSync(Bundle.MedicationBundle)(detailBundle)

    expect(decoded.type).toBe('searchset')
    expect(decoded.entry).toHaveLength(2)

    const kinds = decoded.entry.map((e) => e.resource?.resourceType)
    expect(kinds).toEqual(['MedicationRequest', 'MedicationDispense'])

    const dispense = decoded.entry[1]?.resource
    expect(dispense?.resourceType).toBe('MedicationDispense')
    if (dispense?.resourceType === 'MedicationDispense') {
      expect(dispense.whenHandedOver).not.toBeNull()
      expect(dispense.authorizingPrescription[0]?.reference).toBe('MedicationRequest/mr-0001')
    }
  })
})
