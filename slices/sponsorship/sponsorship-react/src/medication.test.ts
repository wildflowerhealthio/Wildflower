import { Schema } from 'effect'
import { MedicationRequest } from 'fhir-r4/resources'
import { describe, expect, test } from 'vite-plus/test'

import {
  describeDayFromNow,
  medicationRequestsToMedications,
  medicationRequestToMedication,
  medicationRequestToMedicationView,
} from './medication.ts'

const decode = Schema.decodeUnknownSync(MedicationRequest.Schema)

const base = {
  resourceType: 'MedicationRequest',
  status: 'active',
  intent: 'order',
  subject: { reference: 'Patient/1' },
}

// A carebook-dialect request: the Medication is contained and pointed at by a
// `#id` reference, the DIN rides its `code.coding`, and the description /
// remaining-repeats are carebook extensions.
const carebookRequest = {
  ...base,
  id: 'mr-din',
  authoredOn: '2026-06-01T00:00:00Z',
  medicationReference: { reference: '#med-1' },
  contained: [
    {
      resourceType: 'Medication',
      id: 'med-1',
      code: {
        coding: [
          {
            system: 'http://schema.carebook.com/v1/fhir/coding/medication-din-code',
            code: '02241497',
            display: 'Atorvastatin 20 mg tablet',
          },
        ],
      },
      extension: [
        {
          url: 'http://schemas.carebook.com/v1/fhir/medication/extension/description',
          valueString: '20 mg - Tablet',
        },
      ],
    },
  ],
  requester: { display: 'Dr. Jane Smith' },
  note: [{ text: 'Take with food' }],
  dispenseRequest: {
    numberOfRepeatsAllowed: 3,
    modifierExtension: [
      {
        url: 'http://schemas.carebook.com/v2/fhir/medicationrequest/extension/number-of-repeats-available',
        valueDecimal: 0,
      },
    ],
  },
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

  test('names the contained Medication by its coding when no concept/reference display', () => {
    const med = medicationRequestToMedication(decode(carebookRequest), 'fallback')
    expect(med.displayName).toBe('Atorvastatin 20 mg tablet')
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

describe('medicationRequestToMedicationView', () => {
  test('extracts DIN, description, prescriber, note and both repeat counts', () => {
    const view = medicationRequestToMedicationView(decode(carebookRequest), 'fallback')
    expect(view.medication.displayName).toBe('Atorvastatin 20 mg tablet')
    expect(view.din).toBe('02241497')
    expect(view.description).toBe('20 mg - Tablet')
    expect(view.requester).toBe('Dr. Jane Smith')
    expect(view.note).toBe('Take with food')
    expect(view.repeatsAllowed).toBe(3)
    // `valueDecimal: 0` is a real value, not "missing".
    expect(view.repeatsAvailable).toBe(0)
    // No `expectedSupplyDuration` on this request → no next-fill estimate.
    expect(view.nextFillDate).toBeNull()
  })

  test('leaves every carebook field null when the request carries none of them', () => {
    const view = medicationRequestToMedicationView(decode(base), 'fallback')
    expect(view.din).toBeNull()
    expect(view.description).toBeNull()
    expect(view.requester).toBeNull()
    expect(view.note).toBeNull()
    expect(view.repeatsAllowed).toBeNull()
    expect(view.repeatsAvailable).toBeNull()
    expect(view.nextFillDate).toBeNull()
    expect(view.rexallStoreUrl).toBeNull()
  })

  test('builds a Rexall store URL only when both source and store-id extensions are present', () => {
    const sourceExt = {
      url: 'http://schemas.carebook.com/v1/fhir/common/extension/external-system-source',
      valueString: 'RexallPharmacy',
    }
    const storeExt = {
      url: 'http://schemas.carebook.com/v1/fhir/medicationrequest/extension/external-store-id',
      valueString: '8174',
    }

    const both = medicationRequestToMedicationView(
      decode({ ...base, extension: [sourceExt, storeExt] }),
      'fallback'
    )
    expect(both.rexallStoreUrl).toBe('https://www.rexall.ca/storelocator/store/8174')

    // Store id alone (no RexallPharmacy source) → no link.
    const storeOnly = medicationRequestToMedicationView(
      decode({ ...base, extension: [storeExt] }),
      'fallback'
    )
    expect(storeOnly.rexallStoreUrl).toBeNull()

    // Rexall source alone (no store id) → no link.
    const sourceOnly = medicationRequestToMedicationView(
      decode({ ...base, extension: [sourceExt] }),
      'fallback'
    )
    expect(sourceOnly.rexallStoreUrl).toBeNull()
  })

  test('estimates next fill as authoredOn + expectedSupplyDuration', () => {
    const days = medicationRequestToMedicationView(
      decode({
        ...base,
        authoredOn: '2026-06-01T00:00:00Z',
        dispenseRequest: {
          numberOfRepeatsAllowed: 3,
          expectedSupplyDuration: {
            value: 30,
            unit: 'days',
            code: 'd',
            system: 'http://unitsofmeasure.org',
          },
        },
      }),
      'fallback'
    )
    expect(days.nextFillDate).toBe('2026-07-01T00:00:00.000Z')

    // A UCUM week code advances by whole weeks.
    const weeks = medicationRequestToMedicationView(
      decode({
        ...base,
        authoredOn: '2026-06-01T00:00:00Z',
        dispenseRequest: {
          expectedSupplyDuration: { value: 2, code: 'wk', system: 'http://unitsofmeasure.org' },
        },
      }),
      'fallback'
    )
    expect(weeks.nextFillDate).toBe('2026-06-15T00:00:00.000Z')
  })

  test('no next-fill estimate without an authored date', () => {
    const noDate = medicationRequestToMedicationView(
      decode({ ...base, dispenseRequest: { expectedSupplyDuration: { value: 30, code: 'd' } } }),
      'fallback'
    )
    expect(noDate.nextFillDate).toBeNull()
  })

  test('an unrecognized supply unit falls back to days', () => {
    const unknownUnit = medicationRequestToMedicationView(
      decode({
        ...base,
        authoredOn: '2026-06-01T00:00:00Z',
        dispenseRequest: { expectedSupplyDuration: { value: 30, unit: 'doses', code: '{dose}' } },
      }),
      'fallback'
    )
    expect(unknownUnit.nextFillDate).toBe('2026-07-01T00:00:00.000Z')
  })

  test('joins multiple notes with newlines', () => {
    const view = medicationRequestToMedicationView(
      decode({ ...base, note: [{ text: 'First' }, { text: 'Second' }] }),
      'fallback'
    )
    expect(view.note).toBe('First\nSecond')
  })
})

describe('describeDayFromNow', () => {
  // A fixed "now" keeps these deterministic — no wall clock is read.
  const now = Date.parse('2026-06-01T00:00:00Z')
  const at = (iso: string): string => describeDayFromNow(iso, now)

  test('rounds coarsely: days, then weeks past ~10 days, then months', () => {
    expect(at('2026-06-01T05:00:00Z')).toBe('today')
    expect(at('2026-06-02T00:00:00Z')).toBe('in 1 day')
    expect(at('2026-06-04T00:00:00Z')).toBe('in 3 days')
    expect(at('2026-06-15T00:00:00Z')).toBe('in 2 weeks')
    expect(at('2026-07-31T00:00:00Z')).toBe('in 2 months')
  })

  test('describes past dates with an "ago" suffix', () => {
    expect(at('2026-05-29T00:00:00Z')).toBe('3 days ago')
    expect(at('2026-05-18T00:00:00Z')).toBe('2 weeks ago')
  })
})
