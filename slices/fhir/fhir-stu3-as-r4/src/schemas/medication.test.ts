import { AnnotateArrayWithArbitrary } from '@wildflowerhealthio/kitchen-sink/schema'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import {
  CodeableConcept,
  Extension,
  IdentifierAndReference,
} from '@wildflowerhealthio/fhir-r4/data-types'
import {
  Medication as R4Medication,
  MedicationBatch as R4MedicationBatch,
  MedicationIngredient as R4MedicationIngredient,
} from '@wildflowerhealthio/fhir-r4/resources'

import * as Medication from './medication.ts'

const sample: typeof Medication.Schema.Type = {
  resourceType: 'Medication',
  id: 'med-sample',
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  code: null,
  status: null,
  manufacturer: null,
  form: null,
  ingredient: [],
  package: null,
}

const roundTrip = (value: typeof Medication.Schema.Type): void => {
  const wire = Schema.encodeSync(Medication.Schema)(value)
  const decoded = Schema.decodeSync(Medication.Schema)(wire)
  expect(decoded).toSchemaEqual(Medication.Schema, value)
}

describe('Stu3Medication', () => {
  test('encode-decode round-trip with shell medication', () => {
    roundTrip(sample)
  })

  test('property: ingredient and package round-trip', () => {
    fc.assert(
      fc.property(
        fc.record({
          ingredient: Arbitrary.make(
            Schema.Array(Medication.IngredientSchema).pipe(
              AnnotateArrayWithArbitrary({ maxLength: 2 })
            )
          ),
          package: Arbitrary.make(Schema.NullOr(Medication.PackageSchema)),
        }),
        (over) => roundTrip({ ...sample, ...over })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('lenient decode: unknown fields and unknown extension URLs do not fail', () => {
    const decoded = Schema.decodeUnknownSync(Medication.Schema)({
      resourceType: 'Medication',
      id: 'med-lenient',
      code: {
        coding: [{ system: 'http://schema.carebook.com/v1/fhir/CodeSystem/din', code: '02241497' }],
      },
      isBrand: false,
      extension: [
        { url: 'http://schemas.carebook.com/v1/fhir/medication-strength', valueString: '10 mg' },
      ],
    })

    expect(decoded.id).toBe('med-lenient')
    expect(decoded.extension.map((e) => e.url)).toContain(
      'http://schemas.carebook.com/v1/fhir/medication-strength'
    )
  })
})

// STU3 → R4 → STU3: encode the STU3 value to wire, decode straight to R4, then
// back out to STU3. Lossless only over the R4-representable STU3 subset — R4
// holds one `batch` and no package element, so `safeStu3Package` restricts
// `package` to an empty backbone around exactly one batch.
const stu3ToR4ToStu3 = (stu3: typeof Medication.Schema.Type): void => {
  const r4 = Schema.decodeSync(Medication.R4FromStu3Schema)(
    Schema.encodeSync(Medication.Schema)(stu3)
  )
  const back = Schema.decodeSync(Medication.Schema)(
    Schema.encodeSync(Medication.R4FromStu3Schema)(r4)
  )
  expect(back).toSchemaEqual(Medication.Schema, stu3)
}

const r4ToStu3ToR4 = (r4: typeof R4Medication.Schema.Type): void => {
  const back = Schema.decodeSync(Medication.R4FromStu3Schema)(
    Schema.encodeSync(Medication.R4FromStu3Schema)(r4)
  )
  expect(back).toSchemaEqual(Schema.typeSchema(R4Medication.Schema), r4)
}

const ingredientsArb = <A, I>(schema: Schema.Schema<A, I, never>): fc.Arbitrary<readonly A[]> =>
  Arbitrary.make(Schema.Array(schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })))

// A STU3 package that survives the collapse to R4's single `batch` and back:
// empty backbone, exactly one batch.
const safeStu3Package = fc.option(
  Arbitrary.make(R4MedicationBatch.Schema).map((batch): Medication.PackageType => ({
    id: null,
    extension: [],
    modifierExtension: [],
    batch: [batch],
  })),
  { nil: null }
)

// Explicitly constructs the safe R4 subset: `code` / `status` / `manufacturer`
// / `form` / `ingredient` / `batch` / extensions are populated; the slots STU3
// has no room for (`identifier`, `amount`) stay at their `empty` defaults.
const safeR4Medication: fc.Arbitrary<typeof R4Medication.Schema.Type> = fc
  .record({
    code: Arbitrary.make(Schema.NullOr(CodeableConcept.Schema)),
    status: Arbitrary.make(Schema.NullOr(Medication.StatusSchema)),
    manufacturer: Arbitrary.make(Schema.NullOr(IdentifierAndReference.ReferenceSchema)),
    form: Arbitrary.make(Schema.NullOr(CodeableConcept.Schema)),
    ingredient: ingredientsArb(R4MedicationIngredient.Schema),
    batch: Arbitrary.make(Schema.NullOr(R4MedicationBatch.Schema)),
    extension: Arbitrary.make(
      Schema.Array(Extension.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
    ),
  })
  .map((over) => ({ ...R4Medication.empty, ...over }))

describe('Medication.R4FromStu3Schema', () => {
  test('property: an arbitrary STU3 medication converts to R4 and back without loss', () => {
    fc.assert(
      fc.property(
        fc.record({
          code: Arbitrary.make(Schema.NullOr(CodeableConcept.Schema)),
          status: Arbitrary.make(Schema.NullOr(Medication.StatusSchema)),
          manufacturer: Arbitrary.make(Schema.NullOr(IdentifierAndReference.ReferenceSchema)),
          form: Arbitrary.make(Schema.NullOr(CodeableConcept.Schema)),
          ingredient: ingredientsArb(Medication.IngredientSchema),
          package: safeStu3Package,
        }),
        (over) => stu3ToR4ToStu3({ ...sample, ...over })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: a representable R4 medication converts to STU3 and back without loss', () => {
    fc.assert(fc.property(safeR4Medication, r4ToStu3ToR4), { numRuns: numRunsFor({ base: 50 }) })
  })

  test('decoding to R4 keeps the STU3 status and manufacturer', () => {
    const r4 = Schema.decodeUnknownSync(Medication.R4FromStu3Schema)({
      resourceType: 'Medication',
      id: 'med-status',
      status: 'inactive',
      manufacturer: { display: 'Apotex Inc.' },
    })

    expect(r4.status).toBe('inactive')
    expect(r4.manufacturer?.display).toBe('Apotex Inc.')
  })

  test('decoding to R4 maps ingredient amount to strength', () => {
    const r4 = Schema.decodeUnknownSync(Medication.R4FromStu3Schema)({
      resourceType: 'Medication',
      ingredient: [
        {
          itemCodeableConcept: { text: 'atorvastatin' },
          isActive: true,
          amount: { numerator: { value: 10, unit: 'mg' }, denominator: { value: 1, unit: 'tab' } },
        },
      ],
    })

    expect(r4.ingredient).toHaveLength(1)
    expect(r4.ingredient[0]?.strength?.numerator?.value).toBe(10)
    expect(r4.ingredient[0]?.itemCodeableConcept?.text).toBe('atorvastatin')
  })

  test('decoding to R4 keeps the first package batch and drops the rest and the package-only fields', () => {
    const r4 = Schema.decodeUnknownSync(Medication.R4FromStu3Schema)({
      resourceType: 'Medication',
      package: {
        container: { text: 'bottle' },
        content: [{ itemCodeableConcept: { text: 'tablet' } }],
        batch: [
          { lotNumber: 'LOT-1', expirationDate: '2027-01-31T00:00:00Z' },
          { lotNumber: 'LOT-2' },
        ],
      },
    })

    expect(r4.batch?.lotNumber).toBe('LOT-1')
    expect(r4.batch?.expirationDate?.toJSON()).toBe('2027-01-31T00:00:00.000Z')
  })

  test('decoding a package with no batch gives no R4 batch', () => {
    const r4 = Schema.decodeUnknownSync(Medication.R4FromStu3Schema)({
      resourceType: 'Medication',
      package: { container: { text: 'bottle' } },
    })

    expect(r4.batch).toBeNull()
  })

  test('encoding an R4 batch back to STU3 wraps it in a one-batch package', () => {
    const wire = Schema.encodeSync(Medication.R4FromStu3Schema)({
      ...R4Medication.empty,
      batch: {
        id: null,
        extension: [],
        modifierExtension: [],
        lotNumber: 'LOT-1',
        expirationDate: null,
      },
    })

    expect(wire.package?.batch?.map((batch) => batch.lotNumber)).toEqual(['LOT-1'])
  })

  test('encoding an R4-only field (identifier) back to STU3 fails', () => {
    const withIdentifier: typeof R4Medication.Schema.Type = {
      ...R4Medication.empty,
      identifier: [Schema.decodeSync(IdentifierAndReference.IdentifierSchema)({ value: 'med-1' })],
    }
    expect(Either.isLeft(Schema.encodeEither(Medication.R4FromStu3Schema)(withIdentifier))).toBe(
      true
    )
  })

  test('encoding an R4-only field (amount) back to STU3 fails', () => {
    const withAmount: typeof R4Medication.Schema.Type = {
      ...R4Medication.empty,
      amount: { id: null, extension: [], numerator: null, denominator: null },
    }
    expect(Either.isLeft(Schema.encodeEither(Medication.R4FromStu3Schema)(withAmount))).toBe(true)
  })
})
