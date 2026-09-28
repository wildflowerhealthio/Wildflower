import { Schema } from 'effect'
import { CanadianCodingSystem, WildflowerExtension, withMandatoryId } from 'fhir-r4/data-types'
import { MedicationRequest } from 'fhir-r4/resources'

const decode = Schema.decodeUnknownSync(MedicationRequest.Schema)

/** Decode a request the way the FHIR server returns one: with a required `id`. */
const decodeWithId = Schema.decodeUnknownSync(withMandatoryId(MedicationRequest.Schema))

const base = {
  resourceType: 'MedicationRequest',
  status: 'active',
  intent: 'order',
  subject: { reference: 'Patient/1' },
}

const CAREBOOK_DIN_SYSTEM = 'http://schema.carebook.com/v1/fhir/coding/medication-din-code'

// A Rexall request as `rexall-be-well-source` writes it: the Medication is
// contained and pointed at by a `#id` reference, its `code` carries the vendor
// carebook DIN coding beside the canonical twin, the description rides the
// Wildflower extension because the narrative holds other content, and the
// remaining repeats ride the Wildflower extension.
const rexallRequest = {
  ...base,
  id: 'mr-din',
  authoredOn: '2026-06-01T00:00:00Z',
  medicationReference: { reference: '#med-1' },
  contained: [
    {
      resourceType: 'Medication',
      id: 'med-1',
      text: { status: 'additional', div: '<div>Do not crush.</div>' },
      code: {
        coding: [
          { system: CAREBOOK_DIN_SYSTEM, code: '02241497', display: 'Atorvastatin 20 mg tablet' },
          {
            system: CanadianCodingSystem.Din,
            code: '02241497',
            display: 'Atorvastatin 20 mg tablet',
          },
        ],
      },
      extension: [
        { url: WildflowerExtension.MedicationDescription, valueString: '20 mg - Tablet' },
      ],
    },
  ],
  requester: { display: 'Dr. Jane Smith' },
  note: [{ text: 'Take with food' }],
  dispenseRequest: {
    numberOfRepeatsAllowed: 3,
    extension: [{ url: WildflowerExtension.RepeatsAvailable, valueInteger: 0 }],
  },
}

// A Shoppers Drug Mart request: no contained Medication — the DIN rides the
// top-level `medicationCodeableConcept.coding` under the canonical system and
// the sig lives in `dosageInstruction.text`.
const shoppersRequest = {
  ...base,
  id: 'mr-sdm',
  medicationCodeableConcept: {
    text: 'LIPITOR',
    coding: [{ system: CanadianCodingSystem.Din, code: '02241497', display: 'atorvastatin' }],
  },
  dosageInstruction: [{ text: 'Take 1 tablet by mouth once daily' }],
}

// A Rexall request as a real carebook import reads once promoted: no dosage
// instruction at all, a contained Medication whose promoted strength is 10 mg
// per one capsule, and a dispensed supply of 30 capsules over 30 days — enough
// to amortize into 10 mg/day, and nothing else to read a dose from.
const amortizableRexallRequest = {
  ...base,
  id: 'mr-vyvanse',
  status: 'completed',
  authoredOn: '2026-03-02T00:00:00Z',
  medicationReference: { reference: '#med-vyvanse' },
  contained: [
    {
      resourceType: 'Medication',
      id: 'med-vyvanse',
      code: { text: 'VYVANSE 10 mg capsule' },
      ingredient: [
        {
          itemCodeableConcept: { text: 'VYVANSE 10 mg capsule' },
          strength: { numerator: { unit: 'mg', value: 10 }, denominator: { value: 1 } },
        },
      ],
    },
  ],
  dosageInstruction: [],
  dispenseRequest: {
    numberOfRepeatsAllowed: 2,
    quantity: { value: 30, unit: 'capsule' },
    expectedSupplyDuration: {
      value: 30,
      unit: 'day',
      system: 'http://unitsofmeasure.org',
      code: 'd',
    },
    extension: [{ url: WildflowerExtension.RepeatsAvailable, valueInteger: 1 }],
  },
}

const SHOPPERS_DIN_SYSTEM = 'https://mypharmacy.shoppersdrugmart.ca/fhir/CodeSystem/din'

const CAREBOOK_EXTENSION_BASE = 'http://schemas.carebook.com/v1/fhir'
const CAREBOOK_DESCRIPTION_EXTENSION = `${CAREBOOK_EXTENSION_BASE}/medication/extension/description`
const CAREBOOK_REPEATS_AVAILABLE_EXTENSIONS = [
  `${CAREBOOK_EXTENSION_BASE}/medicationrequest/extension/number-of-repeats-available`,
  'http://schemas.carebook.com/v2/fhir/medicationrequest/extension/number-of-repeats-available',
] as const

// A Rexall request in the carebook shape `rexall-be-well-source` promotes: a
// vendor-only DIN coding on both the contained Medication and
// `medicationCodeableConcept`, the description on the carebook extension beside
// the dialect's own narrative (a copy of the drug name), the store as two
// top-level extensions beside an identifier-only performer, and the remaining
// repeats as `modifierExtension` copies. The adapter reads none of the vendor
// shapes; such a resource is re-imported, not read around.
const prePromotionRexallRequest = {
  ...base,
  id: 'mr-pre-rexall',
  medicationCodeableConcept: {
    text: 'Atorvastatin 20 mg tablet',
    coding: [{ system: CAREBOOK_DIN_SYSTEM, code: '02241497' }],
  },
  contained: [
    {
      resourceType: 'Medication',
      id: 'med-1',
      text: {
        status: 'generated',
        div: '<div xmlns="http://www.w3.org/1999/xhtml">Atorvastatin 20 mg tablet</div>',
      },
      code: {
        text: 'Atorvastatin 20 mg tablet',
        coding: [{ system: CAREBOOK_DIN_SYSTEM, code: '02241497' }],
      },
      extension: [{ url: CAREBOOK_DESCRIPTION_EXTENSION, valueString: '20 mg - Tablet' }],
    },
  ],
  extension: [
    {
      url: `${CAREBOOK_EXTENSION_BASE}/common/extension/external-system-source`,
      valueString: 'RexallPharmacy',
    },
    {
      url: `${CAREBOOK_EXTENSION_BASE}/medicationrequest/extension/external-store-id`,
      valueString: '8174',
    },
  ],
  dispenseRequest: {
    numberOfRepeatsAllowed: 3,
    performer: {
      identifier: { system: 'http://schema.carebook.com/identifier/pharmacy', value: 'ph-1' },
    },
    modifierExtension: [
      { url: CAREBOOK_REPEATS_AVAILABLE_EXTENSIONS[0], valuePositiveInt: 2 },
      { url: CAREBOOK_REPEATS_AVAILABLE_EXTENSIONS[1], valueDecimal: 2 },
    ],
  },
}

// A Shoppers Drug Mart request in the shape `shoppers-drugmart-source` no longer
// writes: the DIN under a Shoppers-hosted system only, and the store-locator
// page as a `supportingInformation` reference.
const prePromotionShoppersRequest = {
  ...base,
  id: 'mr-pre-sdm',
  medicationCodeableConcept: {
    text: 'LIPITOR',
    coding: [{ system: SHOPPERS_DIN_SYSTEM, code: '02241497' }],
  },
  supportingInformation: [
    { reference: 'https://www.shoppersdrugmart.ca/store-locator/store/1234' },
  ],
}

export {
  amortizableRexallRequest,
  base,
  CAREBOOK_DESCRIPTION_EXTENSION,
  CAREBOOK_DIN_SYSTEM,
  CAREBOOK_REPEATS_AVAILABLE_EXTENSIONS,
  decode,
  decodeWithId,
  prePromotionRexallRequest,
  prePromotionShoppersRequest,
  rexallRequest,
  SHOPPERS_DIN_SYSTEM,
  shoppersRequest,
}
