import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { CodeableConcept, Extension } from 'fhir-r4/data-types'
import { Medication as R4Medication } from 'fhir-r4/resources'

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
  form: null,
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

  test('lenient decode: unknown fields and unknown extension URLs do not fail', () => {
    const decoded = Schema.decodeUnknownSync(Medication.Schema)({
      resourceType: 'Medication',
      id: 'med-lenient',
      code: {
        coding: [{ system: 'http://schema.carebook.com/v1/fhir/CodeSystem/din', code: '02241497' }],
      },
      manufacturerOnlyOnR4: 'ignored',
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

// STU3 → R4 → STU3: fully representable both ways (STU3 Medication has no field
// R4 can't hold), so this is lossless for every STU3 value.
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

// Explicitly constructs the safe R4 subset: only `code` / `form` / extensions
// are populated; the R4-only slots (`identifier`, `status`, `manufacturer`,
// `amount`, `ingredient`, `batch`) stay at their `empty` defaults.
const safeR4Medication: fc.Arbitrary<typeof R4Medication.Schema.Type> = fc
  .record({
    code: Arbitrary.make(Schema.NullOr(CodeableConcept.Schema)),
    form: Arbitrary.make(Schema.NullOr(CodeableConcept.Schema)),
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
          form: Arbitrary.make(Schema.NullOr(CodeableConcept.Schema)),
        }),
        (over) => stu3ToR4ToStu3({ ...sample, ...over })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: a representable R4 medication converts to STU3 and back without loss', () => {
    fc.assert(fc.property(safeR4Medication, r4ToStu3ToR4), { numRuns: numRunsFor({ base: 50 }) })
  })

  test('encoding an R4-only field (status) back to STU3 fails', () => {
    const withStatus: typeof R4Medication.Schema.Type = { ...R4Medication.empty, status: 'active' }
    expect(Either.isLeft(Schema.encodeEither(Medication.R4FromStu3Schema)(withStatus))).toBe(true)
  })
})
