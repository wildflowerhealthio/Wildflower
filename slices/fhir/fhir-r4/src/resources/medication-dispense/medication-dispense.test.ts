import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { atMostOnePopulatedSlot } from '../../data-types/base/choice-element-passthrough-fields.test-helpers.ts'
import { Code } from '../../data-types/base/code.ts'
import {
  Annotation,
  CodeableConcept,
  Dosage,
  IdentifierAndReference,
  Meta,
  Quantity,
} from '../../data-types/index.ts'
import * as MedicationDispensePerformer from './medication-dispense-performer.ts'
import * as MedicationDispenseSubstitution from './medication-dispense-substitution.ts'
import * as MedicationDispense from './medication-dispense.ts'

// ---------------------------------------------------------------------------
// Decomposed wire-format proof (see observation.test.ts for the rationale):
// one property per field over a fixed shell, each encoding/decoding the WHOLE
// MedicationDispense through `MedicationDispense.Schema`.
// ---------------------------------------------------------------------------

const sampleMedicationDispense: typeof MedicationDispense.Schema.Type = {
  resourceType: 'MedicationDispense',
  id: 'meddisp-id',
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  partOf: [],
  status: 'completed',
  statusReasonCodeableConcept: null,
  statusReasonReference: null,
  category: null,
  medicationCodeableConcept: null,
  medicationReference: null,
  subject: null,
  context: null,
  supportingInformation: [],
  performer: [],
  location: null,
  authorizingPrescription: [],
  type: null,
  quantity: null,
  daysSupply: null,
  whenPrepared: null,
  whenHandedOver: null,
  destination: null,
  receiver: [],
  note: [],
  dosageInstruction: [],
  substitution: null,
  detectedIssue: [],
  eventHistory: [],
}

const roundTrip = (medicationDispense: typeof MedicationDispense.Schema.Type): void => {
  const fhir = Schema.encodeSync(MedicationDispense.Schema)(medicationDispense)
  const decoded = Schema.decodeSync(MedicationDispense.Schema)(fhir)
  expect(decoded).toSchemaEqual(MedicationDispense.Schema, medicationDispense)
}

const overrideArb = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Schema.Type<Schema.Struct<Fields>>> => Arbitrary.make(Schema.Struct(fields))

describe('FhirR4MedicationDispense', () => {
  test('encode-decode round-trip with shell dispense', () => {
    roundTrip(sampleMedicationDispense)
  })

  test('property: status field round-trips', () => {
    fc.assert(
      fc.property(overrideArb({ status: MedicationDispense.StatusSchema }), (override) =>
        roundTrip({ ...sampleMedicationDispense, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: identifier field round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          identifier: Schema.Array(IdentifierAndReference.IdentifierSchema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleMedicationDispense, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: reference-array fields round-trip', () => {
    const references = Schema.Array(IdentifierAndReference.ReferenceSchema).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    )
    fc.assert(
      fc.property(
        overrideArb({
          partOf: references,
          supportingInformation: references,
          authorizingPrescription: references,
          receiver: references,
          detectedIssue: references,
          eventHistory: references,
        }),
        (override) => roundTrip({ ...sampleMedicationDispense, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: nullable single references round-trip', () => {
    const reference = Schema.NullOr(IdentifierAndReference.ReferenceSchema)
    fc.assert(
      fc.property(
        overrideArb({
          subject: reference,
          context: reference,
          location: reference,
          destination: reference,
        }),
        (override) => roundTrip({ ...sampleMedicationDispense, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: nullable single CodeableConcepts round-trip (category / type)', () => {
    const codeableConcept = Schema.NullOr(CodeableConcept.Schema)
    fc.assert(
      fc.property(overrideArb({ category: codeableConcept, type: codeableConcept }), (override) =>
        roundTrip({ ...sampleMedicationDispense, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: statusReason[x] choice field round-trips', () => {
    fc.assert(
      fc.property(
        atMostOnePopulatedSlot({
          statusReasonCodeableConcept: Schema.NullOr(CodeableConcept.Schema),
          statusReasonReference: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
        }),
        (override) => roundTrip({ ...sampleMedicationDispense, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: medication[x] choice field round-trips', () => {
    fc.assert(
      fc.property(
        atMostOnePopulatedSlot({
          medicationCodeableConcept: Schema.NullOr(CodeableConcept.Schema),
          medicationReference: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
        }),
        (override) => roundTrip({ ...sampleMedicationDispense, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: quantity / daysSupply fields round-trip', () => {
    const quantity = Schema.NullOr(Quantity.Schema)
    fc.assert(
      fc.property(overrideArb({ quantity, daysSupply: quantity }), (override) =>
        roundTrip({ ...sampleMedicationDispense, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: performer backbone array round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          performer: Schema.Array(MedicationDispensePerformer.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleMedicationDispense, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: substitution backbone round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({ substitution: Schema.NullOr(MedicationDispenseSubstitution.Schema) }),
        (override) => roundTrip({ ...sampleMedicationDispense, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: note field round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          note: Schema.Array(Annotation.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
        }),
        (override) => roundTrip({ ...sampleMedicationDispense, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: dosageInstruction field round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          dosageInstruction: Schema.Array(Dosage.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleMedicationDispense, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: shell primitives round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          whenPrepared: Schema.NullOr(Schema.DateTimeUtc),
          whenHandedOver: Schema.NullOr(Schema.DateTimeUtc),
          language: Schema.NullOr(Code),
          implicitRules: Schema.NullOr(Schema.URL),
          meta: Schema.NullOr(Meta.Schema),
        }),
        (override) => roundTrip({ ...sampleMedicationDispense, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
