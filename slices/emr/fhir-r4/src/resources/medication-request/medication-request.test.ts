import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { Code } from '../../data-types/base/code.ts'
import {
  Annotation,
  CodeableConcept,
  Dosage,
  IdentifierAndReference,
  Meta,
} from '../../data-types/index.ts'
import * as DispenseRequest from './medication-request-dispense-request.ts'
import * as Substitution from './medication-request-substitution.ts'
import * as MedicationRequest from './medication-request.ts'

// ---------------------------------------------------------------------------
// Decomposed wire-format proof (see observation.test.ts for the rationale):
// one property per field over a fixed shell, each encoding/decoding the WHOLE
// MedicationRequest through `MedicationRequest.Schema` so the wire schema is
// exercised end-to-end at O(field) generation cost.
// ---------------------------------------------------------------------------

const emptyReference: typeof IdentifierAndReference.ReferenceSchema.Type = {
  id: null,
  extension: [],
  display: null,
  identifier: null,
  reference: null,
  type: null,
}

const sampleMedicationRequest: typeof MedicationRequest.Schema.Type = {
  resourceType: 'MedicationRequest',
  id: 'medreq-id',
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  status: 'active',
  statusReason: null,
  intent: 'order',
  category: [],
  priority: null,
  doNotPerform: null,
  reportedBoolean: null,
  reportedReference: null,
  medicationCodeableConcept: null,
  medicationReference: null,
  subject: emptyReference,
  encounter: null,
  supportingInformation: [],
  authoredOn: null,
  requester: null,
  performer: null,
  performerType: null,
  recorder: null,
  reasonCode: [],
  reasonReference: [],
  instantiatesCanonical: [],
  instantiatesUri: [],
  basedOn: [],
  groupIdentifier: null,
  courseOfTherapyType: null,
  insurance: [],
  note: [],
  dosageInstruction: [],
  dispenseRequest: null,
  substitution: null,
  priorPrescription: null,
  detectedIssue: [],
  eventHistory: [],
}

const roundTrip = (medicationRequest: typeof MedicationRequest.Schema.Type): void => {
  const fhir = Schema.encodeSync(MedicationRequest.Schema)(medicationRequest)
  const decoded = Schema.decodeSync(MedicationRequest.Schema)(fhir)
  expect(decoded).toSchemaEqual(MedicationRequest.Schema, medicationRequest)
}

const overrideArb = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Schema.Type<Schema.Struct<Fields>>> => Arbitrary.make(Schema.Struct(fields))

describe('FhirR4MedicationRequest', () => {
  test('encode-decode round-trip with shell request', () => {
    roundTrip(sampleMedicationRequest)
  })

  test('property: status field round-trips', () => {
    fc.assert(
      fc.property(overrideArb({ status: MedicationRequest.StatusSchema }), (override) =>
        roundTrip({ ...sampleMedicationRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: intent / priority fields round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          intent: MedicationRequest.IntentSchema,
          priority: Schema.NullOr(MedicationRequest.PrioritySchema),
        }),
        (override) => roundTrip({ ...sampleMedicationRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: identifier / groupIdentifier fields round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          identifier: Schema.Array(IdentifierAndReference.IdentifierSchema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
          groupIdentifier: Schema.NullOr(IdentifierAndReference.IdentifierSchema),
        }),
        (override) => roundTrip({ ...sampleMedicationRequest, ...override })
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
          supportingInformation: references,
          reasonReference: references,
          basedOn: references,
          insurance: references,
          detectedIssue: references,
          eventHistory: references,
        }),
        (override) => roundTrip({ ...sampleMedicationRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: codeableConcept-array fields round-trip (category / reasonCode)', () => {
    const codeableConcepts = Schema.Array(CodeableConcept.Schema).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    )
    fc.assert(
      fc.property(
        overrideArb({ category: codeableConcepts, reasonCode: codeableConcepts }),
        (override) => roundTrip({ ...sampleMedicationRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: nullable single references round-trip', () => {
    const reference = Schema.NullOr(IdentifierAndReference.ReferenceSchema)
    fc.assert(
      fc.property(
        overrideArb({
          subject: IdentifierAndReference.ReferenceSchema,
          encounter: reference,
          requester: reference,
          performer: reference,
          recorder: reference,
          priorPrescription: reference,
        }),
        (override) => roundTrip({ ...sampleMedicationRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: nullable single CodeableConcepts round-trip', () => {
    const codeableConcept = Schema.NullOr(CodeableConcept.Schema)
    fc.assert(
      fc.property(
        overrideArb({
          statusReason: codeableConcept,
          performerType: codeableConcept,
          courseOfTherapyType: codeableConcept,
        }),
        (override) => roundTrip({ ...sampleMedicationRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: reported[x] choice field round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          reportedBoolean: Schema.NullOr(Schema.Boolean),
          reportedReference: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
        }),
        (override) => roundTrip({ ...sampleMedicationRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: medication[x] choice field round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          medicationCodeableConcept: Schema.NullOr(CodeableConcept.Schema),
          medicationReference: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
        }),
        (override) => roundTrip({ ...sampleMedicationRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: canonical/uri string arrays round-trip', () => {
    const strings = Schema.Array(Schema.String).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
    fc.assert(
      fc.property(
        overrideArb({ instantiatesCanonical: strings, instantiatesUri: strings }),
        (override) => roundTrip({ ...sampleMedicationRequest, ...override })
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
        (override) => roundTrip({ ...sampleMedicationRequest, ...override })
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
        (override) => roundTrip({ ...sampleMedicationRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: dispenseRequest / substitution backbones round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          dispenseRequest: Schema.NullOr(DispenseRequest.Schema),
          substitution: Schema.NullOr(Substitution.Schema),
        }),
        (override) => roundTrip({ ...sampleMedicationRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: shell primitives round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          doNotPerform: Schema.NullOr(Schema.Boolean),
          authoredOn: Schema.NullOr(Schema.DateTimeUtc),
          language: Schema.NullOr(Code),
          implicitRules: Schema.NullOr(Schema.URL),
          meta: Schema.NullOr(Meta.Schema),
        }),
        (override) => roundTrip({ ...sampleMedicationRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
