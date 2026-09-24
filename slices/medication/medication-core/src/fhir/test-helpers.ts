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
// carebook DIN coding beside the canonical twin, the description is still the
// carebook extension (the dialect narrative is a byte-copy of `code.text`), and
// the remaining repeats ride the Wildflower extension.
const rexallRequest = {
  ...base,
  id: 'mr-din',
  authoredOn: '2026-06-01T00:00:00Z',
  medicationReference: { reference: '#med-1' },
  contained: [
    {
      resourceType: 'Medication',
      id: 'med-1',
      text: { status: 'generated', div: 'Atorvastatin 20 mg tablet' },
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

export { base, CAREBOOK_DIN_SYSTEM, decode, rexallRequest, shoppersRequest }
