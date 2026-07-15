import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Medication from './medication.ts'

describe('FhirR4Medication', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(Medication.Schema), (medication) => {
        const fhir = Schema.encodeSync(Medication.Schema)(medication)
        const decoded = Schema.decodeSync(Medication.Schema)(fhir)
        expect(decoded).toSchemaEqual(Medication.Schema, medication)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('empty is a valid, round-trippable Medication', () => {
    const fhir = Schema.encodeSync(Medication.Schema)(Medication.empty)
    expect(Schema.decodeSync(Medication.Schema)(fhir)).toSchemaEqual(
      Medication.Schema,
      Medication.empty
    )
  })

  test('lenient decode: unknown fields are ignored', () => {
    const decoded = Schema.decodeUnknownSync(Medication.Schema)({
      resourceType: 'Medication',
      id: 'med-1',
      status: 'active',
      unmodelledField: { nested: true },
    })

    expect(decoded.id).toBe('med-1')
    expect(decoded.status).toBe('active')
  })
})
