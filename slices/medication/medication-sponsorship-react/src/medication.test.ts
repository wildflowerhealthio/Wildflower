import { Schema } from 'effect'
import { MedicationRequest } from 'fhir-r4/resources'
import { describe, expect, test } from 'vite-plus/test'

import {
  hasRefill,
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
      // The dialect ships a narrative of its own: a byte-copy of `code.text`.
      // It is here so the extension-vs-narrative precedence below is exercised
      // against the shape the vendor really sends, not a stripped-down one.
      text: { status: 'generated', div: 'Atorvastatin 20 mg tablet' },
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

// A Shoppers-Drug-Mart-dialect request: no contained Medication — the DIN rides
// the top-level `medicationCodeableConcept.coding` (under a portal-namespaced
// system) and the sig lives in `dosageInstruction.text`.
const shoppersRequest = {
  ...base,
  id: 'mr-sdm',
  medicationCodeableConcept: {
    text: 'LIPITOR',
    coding: [
      {
        system: 'https://mypharmacy.shoppersdrugmart.ca/fhir/CodeSystem/din',
        code: '02241497',
        display: 'atorvastatin calcium',
      },
    ],
  },
  dosageInstruction: [{ text: 'Take 1 tablet by mouth once daily' }],
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

  test('falls back to the coding display even when the coding carries a system', () => {
    // The top-level `medicationCodeableConcept.coding.system` decodes to a `URL`;
    // the concept reader must still surface the sibling `display`.
    const request = decode({
      ...base,
      medicationCodeableConcept: {
        coding: [
          {
            system: 'https://mypharmacy.shoppersdrugmart.ca/fhir/CodeSystem/din',
            display: 'atorvastatin calcium',
          },
        ],
      },
    })
    expect(medicationRequestToMedication(request, 'fallback').displayName).toBe(
      'atorvastatin calcium'
    )
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

  test('reads the description out of the narrative once the extension has been promoted', () => {
    // `rexall-be-well-collector` promotes the carebook `description` extension
    // into `text.div` and drops the extension. `div` is `xhtml`, so the
    // promoted narrative is markup and the text content is what displays.
    const promoted = {
      ...carebookRequest,
      contained: [
        {
          ...carebookRequest.contained[0],
          text: {
            status: 'generated',
            div: '<div xmlns="http://www.w3.org/1999/xhtml">20 mg - Atorvastatin</div>',
          },
          extension: [],
        },
      ],
    }
    const view = medicationRequestToMedicationView(decode(promoted), 'fallback')
    expect(view.description).toBe('20 mg - Atorvastatin')
  })

  test('unescapes XML entities carried in a promoted narrative', () => {
    const promoted = {
      ...carebookRequest,
      contained: [
        {
          ...carebookRequest.contained[0],
          text: {
            status: 'generated',
            div: '<div xmlns="http://www.w3.org/1999/xhtml">5 mg &amp; 10 mg &lt;combo&gt;</div>',
          },
          extension: [],
        },
      ],
    }
    const view = medicationRequestToMedicationView(decode(promoted), 'fallback')
    expect(view.description).toBe('5 mg & 10 mg <combo>')
  })

  test('prefers the description extension over the dialect narrative before promotion', () => {
    // The un-promoted fixture carries both: the extension's richer description
    // and the dialect's narrative byte-copy of `code.text`. Reading the
    // narrative first would show the drug name the card already displays.
    const view = medicationRequestToMedicationView(decode(carebookRequest), 'fallback')
    expect(view.description).toBe('20 mg - Tablet')
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
    expect(view.shoppersStoreUrl).toBeNull()
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

  test('surfaces a Shoppers store URL from a supportingInformation reference under the store base', () => {
    const withStore = medicationRequestToMedicationView(
      decode({
        ...base,
        supportingInformation: [
          { reference: 'https://www.shoppersdrugmart.ca/store-locator/store/1414' },
        ],
      }),
      'fallback'
    )
    expect(withStore.shoppersStoreUrl).toBe(
      'https://www.shoppersdrugmart.ca/store-locator/store/1414'
    )

    // A supportingInformation reference to anything else is not a store link.
    const other = medicationRequestToMedicationView(
      decode({ ...base, supportingInformation: [{ reference: 'Encounter/9' }] }),
      'fallback'
    )
    expect(other.shoppersStoreUrl).toBeNull()
  })

  test('does not treat validityPeriod.end as a next fill date', () => {
    // `validityPeriod.end` is the *authorization* expiry in R4 — the last date
    // the script may be dispensed against, not when the current supply runs
    // out — so it must not surface as "next fill" on its own.
    const view = medicationRequestToMedicationView(
      decode({
        ...base,
        dispenseRequest: {
          numberOfRepeatsAllowed: 2,
          validityPeriod: { start: '2026-06-01T00:00:00Z', end: '2026-09-01T00:00:00Z' },
        },
      }),
      'fallback'
    )
    expect(view.nextFillDate).toBeNull()
  })

  test('computes the supply-runout even when a validityPeriod is present', () => {
    const view = medicationRequestToMedicationView(
      decode({
        ...base,
        authoredOn: '2026-06-01T00:00:00Z',
        dispenseRequest: {
          expectedSupplyDuration: { value: 30, code: 'd', system: 'http://unitsofmeasure.org' },
          validityPeriod: { end: '2026-12-31T00:00:00Z' },
        },
      }),
      'fallback'
    )
    expect(view.nextFillDate).toBe('2026-07-01T00:00:00.000Z')
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

  test('falls back to a DIN-system medicationCodeableConcept coding for DIN', () => {
    const view = medicationRequestToMedicationView(decode(shoppersRequest), 'fallback')
    expect(view.din).toBe('02241497')
  })

  test.each([
    { label: 'RxNorm', system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '1049221' },
    { label: 'SNOMED CT', system: 'http://snomed.info/sct', code: '108537001' },
    { label: 'systemless', system: undefined, code: '12345678' },
  ])('does not surface a $label coding as a DIN', ({ system, code }) => {
    // A generic FHIR R4 source spells `medicationCodeableConcept` with a drug
    // vocabulary that is not a DIN; printing its code as "DIN …" would be a
    // confidently wrong identifier.
    const view = medicationRequestToMedicationView(
      decode({
        ...base,
        medicationCodeableConcept: {
          text: 'Oxycodone 5mg',
          coding: [{ ...(system === undefined ? {} : { system }), code }],
        },
      }),
      'fallback'
    )
    expect(view.din).toBeNull()
  })

  test('falls back to the joined dosageInstruction sig for the description', () => {
    const view = medicationRequestToMedicationView(
      decode({
        ...shoppersRequest,
        dosageInstruction: [{ text: 'Take 1 tablet by mouth once daily' }, { text: 'With food' }],
      }),
      'fallback'
    )
    expect(view.description).toBe('Take 1 tablet by mouth once daily\nWith food')
  })

  test('prefers the contained Medication DIN and description over the concept/sig fallbacks', () => {
    const view = medicationRequestToMedicationView(
      decode({
        ...carebookRequest,
        medicationCodeableConcept: { coding: [{ code: 'DO-NOT-USE' }] },
        dosageInstruction: [{ text: 'do-not-use sig' }],
      }),
      'fallback'
    )
    expect(view.din).toBe('02241497')
    expect(view.description).toBe('20 mg - Tablet')
  })

  test('joins multiple notes with newlines', () => {
    const view = medicationRequestToMedicationView(
      decode({ ...base, note: [{ text: 'First' }, { text: 'Second' }] }),
      'fallback'
    )
    expect(view.note).toBe('First\nSecond')
  })
})

describe('hasRefill', () => {
  const view = (
    repeatsAllowed: number | null,
    repeatsAvailable: number | null
  ): Parameters<typeof hasRefill>[0] =>
    medicationRequestToMedicationView(
      decode({
        ...base,
        dispenseRequest: {
          ...(repeatsAllowed === null ? {} : { numberOfRepeatsAllowed: repeatsAllowed }),
          modifierExtension:
            repeatsAvailable === null
              ? []
              : [
                  {
                    url: 'http://schemas.carebook.com/v2/fhir/medicationrequest/extension/number-of-repeats-available',
                    valueDecimal: repeatsAvailable,
                  },
                ],
        },
      }),
      'fallback'
    )

  test('is true only when repeats are allowed and at least one remains', () => {
    expect(hasRefill(view(3, 2))).toBe(true)
    // Repeats allowed but none left → no refill (supply merely exhausts).
    expect(hasRefill(view(3, 0))).toBe(false)
    // No repeats allowed at all.
    expect(hasRefill(view(0, 0))).toBe(false)
    expect(hasRefill(view(null, null))).toBe(false)
  })
})
