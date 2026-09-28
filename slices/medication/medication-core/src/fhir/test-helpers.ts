import { Schema } from 'effect'
import { CanadianCodingSystem, WildflowerExtension } from 'fhir-r4/data-types'
import { MedicationRequest } from 'fhir-r4/resources'

const decode = Schema.decodeUnknownSync(MedicationRequest.Schema)

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

const SHOPPERS_DIN_SYSTEM = 'https://mypharmacy.shoppersdrugmart.ca/fhir/CodeSystem/din'

const CAREBOOK_EXTENSION_BASE = 'http://schemas.carebook.com/v1/fhir'
const CAREBOOK_DESCRIPTION_EXTENSION = `${CAREBOOK_EXTENSION_BASE}/medication/extension/description`
const CAREBOOK_REPEATS_AVAILABLE_EXTENSIONS = [
  `${CAREBOOK_EXTENSION_BASE}/medicationrequest/extension/number-of-repeats-available`,
  'http://schemas.carebook.com/v2/fhir/medicationrequest/extension/number-of-repeats-available',
] as const

// A Rexall request in the carebook shape, before `rexall-be-well-source`
// promotes it: a vendor-only DIN coding, the description on the carebook
// extension, the store as two top-level extensions beside an identifier-only
// performer, and the remaining repeats as `modifierExtension` copies. The
// adapter reads none of these; such a resource is re-imported, not read around.
const prePromotionRexallRequest = {
  ...base,
  id: 'mr-pre-rexall',
  medicationReference: { reference: '#med-1' },
  contained: [
    {
      resourceType: 'Medication',
      id: 'med-1',
      code: { coding: [{ system: CAREBOOK_DIN_SYSTEM, code: '02241497' }] },
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

// A Shoppers Drug Mart request before `shoppers-drugmart-source` promotes it:
// the DIN under the vendor system only, and the store-locator page as a
// `supportingInformation` reference.
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
  base,
  CAREBOOK_DESCRIPTION_EXTENSION,
  CAREBOOK_DIN_SYSTEM,
  CAREBOOK_REPEATS_AVAILABLE_EXTENSIONS,
  decode,
  prePromotionRexallRequest,
  prePromotionShoppersRequest,
  rexallRequest,
  SHOPPERS_DIN_SYSTEM,
  shoppersRequest,
}
