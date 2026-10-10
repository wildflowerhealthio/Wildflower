import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { IdentifierAndReference, Quantity, SimpleQuantity } from 'fhir-r4/data-types'
import { MedicationDispense as R4MedicationDispense } from 'fhir-r4/resources'

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

// STU3 → R4 → STU3: encode the STU3 value to wire, decode straight to R4, then
// back out to STU3. MedicationDispense is fully representable both ways, so this
// is lossless for every STU3 value.
const stu3ToR4ToStu3 = (stu3: typeof MedicationDispense.Schema.Type): void => {
  const r4 = Schema.decodeSync(MedicationDispense.R4FromStu3Schema)(
    Schema.encodeSync(MedicationDispense.Schema)(stu3)
  )
  const back = Schema.decodeSync(MedicationDispense.Schema)(
    Schema.encodeSync(MedicationDispense.R4FromStu3Schema)(r4)
  )
  expect(back).toSchemaEqual(MedicationDispense.Schema, stu3)
}

// R4 → STU3 → R4 for a value known to be in the STU3-representable subset.
const r4ToStu3ToR4 = (r4: typeof R4MedicationDispense.Schema.Type): void => {
  const back = Schema.decodeSync(MedicationDispense.R4FromStu3Schema)(
    Schema.encodeSync(MedicationDispense.R4FromStu3Schema)(r4)
  )
  expect(back).toSchemaEqual(Schema.typeSchema(R4MedicationDispense.Schema), r4)
}

const widen = (
  simple: typeof SimpleQuantity.Schema.Type | null
): typeof Quantity.Schema.Type | null =>
  simple === null ? null : Quantity.fromSimpleQuantity(simple)

// Explicitly constructs the safe R4 subset: only the fields STU3 can hold are
// populated (with widened, comparator-free quantities); every other R4 field
// stays at its `empty` default. Any value drawn from here is guaranteed to
// encode back to STU3, so the round-trip below never has to filter.
const safeR4Dispense: fc.Arbitrary<typeof R4MedicationDispense.Schema.Type> = fc
  .record({
    status: Arbitrary.make(MedicationDispense.StatusSchema),
    identifier: Arbitrary.make(
      Schema.Array(IdentifierAndReference.IdentifierSchema).pipe(
        AnnotateArrayWithArbitrary({ maxLength: 2 })
      )
    ),
    subject: Arbitrary.make(Schema.NullOr(IdentifierAndReference.ReferenceSchema)),
    context: Arbitrary.make(Schema.NullOr(IdentifierAndReference.ReferenceSchema)),
    authorizingPrescription: Arbitrary.make(
      Schema.Array(IdentifierAndReference.ReferenceSchema).pipe(
        AnnotateArrayWithArbitrary({ maxLength: 2 })
      )
    ),
    quantity: Arbitrary.make(Schema.NullOr(SimpleQuantity.Schema)).map(widen),
    daysSupply: Arbitrary.make(Schema.NullOr(SimpleQuantity.Schema)).map(widen),
    whenPrepared: Arbitrary.make(Schema.NullOr(Schema.DateTimeUtc)),
    whenHandedOver: Arbitrary.make(Schema.NullOr(Schema.DateTimeUtc)),
  })
  .map((over) => ({ ...R4MedicationDispense.empty, ...over }))

describe('MedicationDispense.R4FromStu3Schema', () => {
  test('property: an arbitrary STU3 dispense converts to R4 and back without loss', () => {
    fc.assert(
      fc.property(
        overrideArb({
          status: MedicationDispense.StatusSchema,
          subject: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
          context: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
          quantity: Schema.NullOr(SimpleQuantity.Schema),
          daysSupply: Schema.NullOr(SimpleQuantity.Schema),
          whenHandedOver: Schema.NullOr(Schema.DateTimeUtc),
        }),
        (override) => stu3ToR4ToStu3({ ...sample, ...override })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: a representable R4 dispense converts to STU3 and back without loss', () => {
    fc.assert(fc.property(safeR4Dispense, r4ToStu3ToR4), { numRuns: numRunsFor({ base: 50 }) })
  })

  test('encoding an R4-only field back to STU3 fails (limit of the safe subset)', () => {
    const withPartOf: typeof R4MedicationDispense.Schema.Type = {
      ...R4MedicationDispense.empty,
      status: 'completed',
      partOf: [IdentifierAndReference.emptyReference],
    }
    const result = Schema.encodeEither(MedicationDispense.R4FromStu3Schema)(withPartOf)
    expect(Either.isLeft(result)).toBe(true)
  })

  test('encoding an R4-only status back to STU3 fails', () => {
    const declined: typeof R4MedicationDispense.Schema.Type = {
      ...R4MedicationDispense.empty,
      status: 'declined',
    }
    const result = Schema.encodeEither(MedicationDispense.R4FromStu3Schema)(declined)
    expect(Either.isLeft(result)).toBe(true)
  })
})
