import { Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { Bundle, MedicationDispense, MedicationRequest } from 'fhir-stu3-as-r4/schemas'

import { MedicationBundle, MedicationRequestBundle } from './bundle.ts'
import detailBundle from './fixtures/detail-bundle.json' with { type: 'json' }
import listBundle from './fixtures/list-bundle.json' with { type: 'json' }

describe('carebook STU3 searchset Bundle decode', () => {
  test('decodes the list bundle (MedicationRequests with contained Medication)', () => {
    const decoded = Schema.decodeUnknownSync(MedicationRequestBundle)(listBundle)

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

  test('decodes the detail bundle (mixed MedicationRequest + MedicationDispense)', () => {
    const decoded = Schema.decodeUnknownSync(MedicationBundle)(detailBundle)

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

describe('carebook STU3 bundle decoded straight to R4', () => {
  // Wrapping the `R4FromStu3Schema` transforms in the searchset factory decodes
  // the STU3 wire bundle directly into fhir-r4 resource values.
  const R4RequestBundle = Bundle.searchsetBundle(MedicationRequest.R4FromStu3Schema)
  const R4MixedBundle = Bundle.searchsetBundle(
    Schema.Union(MedicationRequest.R4FromStu3Schema, MedicationDispense.R4FromStu3Schema)
  )

  test('MedicationRequest: requester.agent flattens, context → encounter, quantity widens', () => {
    const r4 = Schema.decodeUnknownSync(R4RequestBundle)(listBundle).entry[0]?.resource
    if (r4 === undefined || r4 === null) throw new Error('fixture missing MedicationRequest')

    expect(r4.id).toBe('mr-0001')
    expect(r4.requester?.reference).toBe('Practitioner/dr-smith')
    expect(r4.requester?.display).toBe('Dr. Jane Smith')
    expect(r4.encounter?.reference).toBe('Encounter/enc-0001')
    expect(r4.status).toBe('active')
    expect(r4.intent).toBe('order')
    // Carebook extensions ride through verbatim onto the R4 resource.
    expect(r4.extension.map((e) => e.url)).toContain(
      'http://schemas.carebook.com/v1/fhir/request-type'
    )
    expect(r4.extension.map((e) => e.url)).toContain('http://example.org/unknown-future-extension')
    expect(r4.contained).toHaveLength(1)
    expect(r4.dispenseRequest?.numberOfRepeatsAllowed).toBe(3)
    expect(r4.dispenseRequest?.quantity?.value).toBe(30)
    expect(r4.dispenseRequest?.modifierExtension.map((e) => e.url)).toContain(
      'http://schemas.carebook.com/v1/fhir/number-of-repeats-available'
    )
  })

  test('MedicationDispense: context maps, quantity/daysSupply widen to R4 Quantity', () => {
    const r4 = Schema.decodeUnknownSync(R4MixedBundle)(detailBundle).entry[1]?.resource
    if (r4 === undefined || r4 === null || r4.resourceType !== 'MedicationDispense') {
      throw new Error('fixture missing MedicationDispense')
    }

    expect(r4.id).toBe('md-0001')
    expect(r4.context?.reference).toBe('Encounter/enc-0001')
    expect(r4.quantity?.value).toBe(30)
    expect(r4.daysSupply?.value).toBe(30)
    expect(r4.whenHandedOver).not.toBeNull()
    expect(r4.extension.map((e) => e.url)).toContain(
      'http://schemas.carebook.com/v1/fhir/estimated-pick-up'
    )
  })
})
