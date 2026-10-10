import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { atMostOnePopulatedSlot } from '../base/choice-element-passthrough-fields.test-helpers.ts'
import * as CodeableConcept from './codeable-concept.ts'
import * as Dosage from './dosage.ts'
import * as Ratio from './ratio.ts'
import * as SimpleQuantity from './simple-quantity.ts'
import * as Timing from './timing.ts'

// ---------------------------------------------------------------------------
// Dosage nests Timing plus several CodeableConcept arrays and a doseAndRate
// backbone; round-tripping an arbitrary over the whole struct blows the
// fast-check budget the same way Observation did. We keep the wire-format
// proof by decomposing into one property per field: each generates only that
// field's content, spreads it onto a fixed shell Dosage, and encodes/decodes
// the WHOLE Dosage — so the wire schema is still exercised end-to-end.
// ---------------------------------------------------------------------------

const sampleDosage: typeof Dosage.Schema.Type = {
  id: null,
  extension: [],
  modifierExtension: [],
  sequence: null,
  text: null,
  additionalInstruction: [],
  patientInstruction: null,
  timing: null,
  asNeededBoolean: null,
  asNeededCodeableConcept: null,
  site: null,
  route: null,
  method: null,
  doseAndRate: [],
  maxDosePerPeriod: null,
  maxDosePerAdministration: null,
  maxDosePerLifetime: null,
}

const roundTrip = (dosage: typeof Dosage.Schema.Type): void => {
  const fhir = Schema.encodeSync(Dosage.Schema)(dosage)
  const decoded = Schema.decodeSync(Dosage.Schema)(fhir)
  expect(decoded).toSchemaEqual(Dosage.Schema, dosage)
}

const overrideArb = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Schema.Type<Schema.Struct<Fields>>> => Arbitrary.make(Schema.Struct(fields))

describe('FhirR4DosageDoseAndRate', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(Dosage.DosageDoseAndRateSchema), (doseAndRate) => {
        const fhir = Schema.encodeSync(Dosage.DosageDoseAndRateSchema)(doseAndRate)
        const decoded = Schema.decodeSync(Dosage.DosageDoseAndRateSchema)(fhir)
        expect(decoded).toSchemaEqual(Dosage.DosageDoseAndRateSchema, doseAndRate)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('FhirR4Dosage', () => {
  test('encode-decode round-trip with shell dosage', () => {
    roundTrip(sampleDosage)
  })

  test('property: scalar fields round-trip (sequence / text / patientInstruction)', () => {
    fc.assert(
      fc.property(
        overrideArb({
          sequence: Schema.NullOr(Schema.Int),
          text: Schema.NullOr(Schema.String),
          patientInstruction: Schema.NullOr(Schema.String),
        }),
        (override) => roundTrip({ ...sampleDosage, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: nullable single CodeableConcepts round-trip (site / route / method)', () => {
    const codeableConcept = Schema.NullOr(CodeableConcept.Schema)
    fc.assert(
      fc.property(
        overrideArb({ site: codeableConcept, route: codeableConcept, method: codeableConcept }),
        (override) => roundTrip({ ...sampleDosage, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: additionalInstruction array round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          additionalInstruction: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleDosage, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: timing field round-trips', () => {
    fc.assert(
      fc.property(overrideArb({ timing: Schema.NullOr(Timing.Schema) }), (override) =>
        roundTrip({ ...sampleDosage, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: asNeeded[x] choice field round-trips', () => {
    fc.assert(
      fc.property(
        atMostOnePopulatedSlot({
          asNeededBoolean: Schema.NullOr(Schema.Boolean),
          asNeededCodeableConcept: Schema.NullOr(CodeableConcept.Schema),
        }),
        (override) => roundTrip({ ...sampleDosage, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: doseAndRate array round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          doseAndRate: Schema.Array(Dosage.DosageDoseAndRateSchema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleDosage, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: max-dose fields round-trip (period / administration / lifetime)', () => {
    fc.assert(
      fc.property(
        overrideArb({
          maxDosePerPeriod: Schema.NullOr(Ratio.Schema),
          maxDosePerAdministration: Schema.NullOr(SimpleQuantity.Schema),
          maxDosePerLifetime: Schema.NullOr(SimpleQuantity.Schema),
        }),
        (override) => roundTrip({ ...sampleDosage, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
