import { Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import {
  MedicationDispense as R4MedicationDispense,
  MedicationRequest as R4MedicationRequest,
} from 'fhir-r4/resources'

import detailBundle from '../fixtures/detail-bundle.json' with { type: 'json' }
import listBundle from '../fixtures/list-bundle.json' with { type: 'json' }
import * as Bundle from '../schemas/bundle.ts'
import { transformMedicationDispense, transformMedicationRequest } from './index.ts'

const listEntries = Schema.decodeUnknownSync(Bundle.MedicationRequestBundle)(listBundle).entry
const detailEntries = Schema.decodeUnknownSync(Bundle.MedicationBundle)(detailBundle).entry

/** Proves an R4 resource passes the fhir-r4 schema by round-tripping it through encode/decode. */
const passesR4MedicationRequest = (
  value: typeof R4MedicationRequest.Schema.Type
): typeof R4MedicationRequest.Schema.Type =>
  Schema.decodeUnknownSync(R4MedicationRequest.Schema)(
    Schema.encodeUnknownSync(R4MedicationRequest.Schema)(value)
  )

const passesR4MedicationDispense = (
  value: typeof R4MedicationDispense.Schema.Type
): typeof R4MedicationDispense.Schema.Type =>
  Schema.decodeUnknownSync(R4MedicationDispense.Schema)(
    Schema.encodeUnknownSync(R4MedicationDispense.Schema)(value)
  )

describe('transformMedicationRequest', () => {
  const source = listEntries[0]?.resource
  if (source === undefined || source === null) throw new Error('fixture missing MedicationRequest')
  const r4 = transformMedicationRequest(source)

  test('emits an R4 MedicationRequest that passes the fhir-r4 schema', () => {
    expect(() => passesR4MedicationRequest(r4)).not.toThrow()
    expect(passesR4MedicationRequest(r4).id).toBe('mr-0001')
  })

  test('STU3 requester.agent → R4 requester, carrying the physician display', () => {
    expect(r4.requester?.reference).toBe('Practitioner/dr-smith')
    expect(r4.requester?.display).toBe('Dr. Jane Smith')
  })

  test('STU3 context → R4 encounter', () => {
    expect(r4.encounter?.reference).toBe('Encounter/enc-0001')
  })

  test('status / intent map through unchanged', () => {
    expect(r4.status).toBe('active')
    expect(r4.intent).toBe('order')
  })

  test('carebook extensions are preserved verbatim on the R4 resource', () => {
    expect(r4.extension.map((e) => e.url)).toContain(
      'http://schemas.carebook.com/v1/fhir/request-type'
    )
    expect(r4.extension.map((e) => e.url)).toContain('http://example.org/unknown-future-extension')
  })

  test('contained Medication is carried onto the R4 resource', () => {
    expect(r4.contained).toHaveLength(1)
  })

  test('dispenseRequest maps, preserving the number-of-repeats-available modifierExtension', () => {
    expect(r4.dispenseRequest?.numberOfRepeatsAllowed).toBe(3)
    expect(r4.dispenseRequest?.quantity?.value).toBe(30)
    expect(r4.dispenseRequest?.modifierExtension.map((e) => e.url)).toContain(
      'http://schemas.carebook.com/v1/fhir/number-of-repeats-available'
    )
  })
})

describe('transformMedicationDispense', () => {
  const source = detailEntries[1]?.resource
  if (source === undefined || source === null || source.resourceType !== 'MedicationDispense') {
    throw new Error('fixture missing MedicationDispense')
  }
  const r4 = transformMedicationDispense(source)

  test('emits an R4 MedicationDispense that passes the fhir-r4 schema', () => {
    expect(() => passesR4MedicationDispense(r4)).not.toThrow()
    expect(passesR4MedicationDispense(r4).id).toBe('md-0001')
  })

  test('STU3 context → R4 context; quantity/daysSupply widened to R4 Quantity', () => {
    expect(r4.context?.reference).toBe('Encounter/enc-0001')
    expect(r4.quantity?.value).toBe(30)
    expect(r4.daysSupply?.value).toBe(30)
  })

  test('whenHandedOver and carebook extensions are preserved', () => {
    expect(r4.whenHandedOver).not.toBeNull()
    expect(r4.extension.map((e) => e.url)).toContain(
      'http://schemas.carebook.com/v1/fhir/estimated-pick-up'
    )
  })
})
