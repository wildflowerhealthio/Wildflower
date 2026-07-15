import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { IdentifierAndReference, SimpleQuantity } from 'fhir-r4/data-types'

import * as MedicationDispense from './medication-dispense.ts'

const sample: typeof MedicationDispense.Schema.Type = {
  resourceType: 'MedicationDispense',
  id: 'md-sample',
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  status: 'completed',
  medicationReference: null,
  medicationCodeableConcept: null,
  subject: null,
  context: null,
  authorizingPrescription: [],
  quantity: null,
  daysSupply: null,
  whenPrepared: null,
  whenHandedOver: null,
}

const roundTrip = (value: typeof MedicationDispense.Schema.Type): void => {
  const wire = Schema.encodeSync(MedicationDispense.Schema)(value)
  const decoded = Schema.decodeSync(MedicationDispense.Schema)(wire)
  expect(decoded).toSchemaEqual(MedicationDispense.Schema, value)
}

const overrideArb = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Schema.Type<Schema.Struct<Fields>>> => Arbitrary.make(Schema.Struct(fields))

describe('Stu3MedicationDispense', () => {
  test('encode-decode round-trip with shell dispense', () => {
    roundTrip(sample)
  })

  test('property: status round-trips', () => {
    fc.assert(
      fc.property(overrideArb({ status: MedicationDispense.StatusSchema }), (override) =>
        roundTrip({ ...sample, ...override })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: quantity / daysSupply (SimpleQuantity) round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          quantity: Schema.NullOr(SimpleQuantity.Schema),
          daysSupply: Schema.NullOr(SimpleQuantity.Schema),
        }),
        (override) => roundTrip({ ...sample, ...override })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: references (subject / context / authorizingPrescription) round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          subject: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
          context: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
          authorizingPrescription: Schema.Array(IdentifierAndReference.ReferenceSchema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sample, ...override })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: whenPrepared / whenHandedOver round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          whenPrepared: Schema.NullOr(Schema.DateTimeUtc),
          whenHandedOver: Schema.NullOr(Schema.DateTimeUtc),
        }),
        (override) => roundTrip({ ...sample, ...override })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('lenient decode: unknown fields and unknown extension URLs do not fail', () => {
    const decoded = Schema.decodeUnknownSync(MedicationDispense.Schema)({
      resourceType: 'MedicationDispense',
      id: 'md-lenient',
      status: 'completed',
      carebookLegacyId: 'legacy-777',
      extension: [{ url: 'http://example.org/unknown', valueBoolean: false }],
    })

    expect(decoded.id).toBe('md-lenient')
    expect(decoded.extension.map((e) => e.url)).toContain('http://example.org/unknown')
  })
})
