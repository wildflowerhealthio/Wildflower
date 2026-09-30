import { Arbitrary, DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  atLeastTwoPopulatedSlots,
  atMostOnePopulatedSlot,
  expectChoiceElementGuardFailure,
} from '../../data-types/base/choice-element-passthrough-fields.test-helpers.ts'
import { Code } from '../../data-types/base/code.ts'
import {
  Annotation,
  CodeableConcept,
  IdentifierAndReference,
  Meta,
  Period,
  Range,
} from '../../data-types/index.ts'
import * as ProcedureFocalDevice from './procedure-focal-device.ts'
import * as ProcedurePerformer from './procedure-performer.ts'
import * as Procedure from './procedure.ts'
import { SearchParams } from './search-params.ts'

// ---------------------------------------------------------------------------
// Decomposed wire-format proof (see observation.test.ts): each property
// generates one field group from the component schema the struct embeds,
// spreads it over a fixed shell, and round-trips the WHOLE Procedure.
// ---------------------------------------------------------------------------

const sampleProcedure: typeof Procedure.Schema.Type = {
  resourceType: 'Procedure',
  id: 'proc-1',
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  instantiatesCanonical: [],
  instantiatesUri: [],
  basedOn: [],
  partOf: [],
  status: 'completed',
  statusReason: null,
  category: null,
  code: null,
  subject: {
    id: null,
    extension: [],
    reference: 'Patient/p-1',
    type: null,
    identifier: null,
    display: null,
  },
  encounter: null,
  performedDateTime: null,
  performedPeriod: null,
  performedString: null,
  performedAge: null,
  performedRange: null,
  recorder: null,
  asserter: null,
  performer: [],
  location: null,
  reasonCode: [],
  reasonReference: [],
  bodySite: [],
  outcome: null,
  report: [],
  complication: [],
  complicationDetail: [],
  followUp: [],
  note: [],
  focalDevice: [],
  usedReference: [],
  usedCode: [],
}

const roundTrip = (resource: typeof Procedure.Schema.Type): void => {
  const fhir = Schema.encodeSync(Procedure.Schema)(resource)
  const decoded = Schema.decodeSync(Procedure.Schema)(fhir)
  expect(decoded).toSchemaEqual(Procedure.Schema, resource)
}

const overrideArb = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Schema.Type<Schema.Struct<Fields>>> => Arbitrary.make(Schema.Struct(fields))

const referenceArray = Schema.Array(IdentifierAndReference.ReferenceSchema).pipe(
  AnnotateArrayWithArbitrary({ maxLength: 2 })
)

const codeableConceptArray = Schema.Array(CodeableConcept.Schema).pipe(
  AnnotateArrayWithArbitrary({ maxLength: 2 })
)

describe('FhirR4Procedure', () => {
  test('decodes a minimal wire procedure, defaulting every absent field', () => {
    // Arrange — only the 1..1 elements
    const wire = {
      resourceType: 'Procedure',
      id: 'proc-1',
      status: 'completed',
      subject: { reference: 'Patient/p-1' },
    }

    // Act
    const decoded = Schema.decodeUnknownSync(Procedure.Schema)(wire)

    // Assert
    expect(decoded).toSchemaEqual(Procedure.Schema, sampleProcedure)
  })

  test('decodes a full workout procedure and re-encodes every field it set', () => {
    // Arrange — one workout: carries out two exercise orders, spans the session
    const wire = {
      resourceType: 'Procedure',
      id: 'workout-1',
      identifier: [{ system: 'http://example.com/workouts', value: 'w-1' }],
      instantiatesCanonical: ['http://example.com/PlanDefinition/starting-strength'],
      instantiatesUri: ['http://example.com/protocols/5x5'],
      basedOn: [{ reference: 'ServiceRequest/squat' }, { reference: 'ServiceRequest/bench' }],
      partOf: [{ reference: 'Procedure/program-1' }],
      status: 'completed',
      statusReason: { text: 'finished early' },
      category: { coding: [{ system: 'http://snomed.info/sct', code: '229065009' }] },
      code: { text: 'Strength training session' },
      subject: { reference: 'Patient/p-1' },
      encounter: { reference: 'Encounter/e-1' },
      performedPeriod: { start: '2026-09-30T22:00:00.000Z', end: '2026-09-30T23:15:00.000Z' },
      recorder: { reference: 'Patient/p-1' },
      asserter: { reference: 'Patient/p-1' },
      performer: [
        {
          function: { text: 'lifter' },
          actor: { reference: 'Patient/p-1' },
          onBehalfOf: { reference: 'Organization/gym' },
        },
      ],
      location: { reference: 'Location/gym' },
      reasonCode: [{ text: 'strength' }],
      reasonReference: [{ reference: 'Goal/g-1' }],
      bodySite: [{ text: 'lower body' }],
      outcome: { text: 'successful' },
      report: [{ reference: 'DiagnosticReport/r-1' }],
      complication: [{ text: 'blister' }],
      complicationDetail: [{ reference: 'Condition/c-1' }],
      followUp: [{ text: 'deload next week' }],
      note: [{ text: 'felt strong' }],
      focalDevice: [{ action: { text: 'used' }, manipulated: { reference: 'Device/barbell' } }],
      usedReference: [{ reference: 'Device/rack' }],
      usedCode: [{ text: 'belt' }],
    }

    // Act
    const decoded = Schema.decodeUnknownSync(Procedure.Schema)(wire)

    // Assert
    expect(decoded.basedOn.map((reference) => reference.reference)).toEqual([
      'ServiceRequest/squat',
      'ServiceRequest/bench',
    ])
    expect(decoded.performer[0]?.actor.reference).toBe('Patient/p-1')
    expect(decoded.focalDevice[0]?.manipulated.reference).toBe('Device/barbell')
    expect(decoded.note[0]?.text).toBe('felt strong')
    // A complex choice slot is typed `any`; read it back through its decoded schema
    const { start } = Schema.decodeUnknownSync(Schema.typeSchema(Period.Schema))(
      decoded.performedPeriod
    )
    expect(start && DateTime.formatIso(start)).toBe('2026-09-30T22:00:00.000Z')
    // Encode also emits the defaulted fields, so compare only what the wire set
    expect(Schema.encodeSync(Procedure.Schema)(decoded)).toMatchObject(wire)
  })

  test('encode-decode round-trip with shell procedure', () => {
    roundTrip(sampleProcedure)
  })

  test.each(['status', 'subject', 'resourceType'] as const)(
    'rejects a procedure with no %s — the spec marks it 1..1',
    (field) => {
      const { [field]: _dropped, ...without } = Schema.encodeSync(Procedure.Schema)(sampleProcedure)
      expect(Schema.decodeUnknownEither(Procedure.Schema)(without)._tag).toBe('Left')
    }
  )

  test.each([
    // `active` is a request status, not an event status
    { field: 'status', value: 'active' },
    { field: 'resourceType', value: 'ServiceRequest' },
  ])('rejects $field=$value', ({ field, value }) => {
    const wire = Schema.encodeSync(Procedure.Schema)(sampleProcedure)
    expect(Schema.decodeUnknownEither(Procedure.Schema)({ ...wire, [field]: value })._tag).toBe(
      'Left'
    )
  })

  test.each([
    { field: 'performer', entry: { function: { text: 'lifter' } } },
    { field: 'focalDevice', entry: { action: { text: 'used' } } },
  ])('rejects a $field entry without its 1..1 reference', ({ field, entry }) => {
    expect(
      Schema.decodeUnknownEither(Procedure.Schema)({
        ...Schema.encodeSync(Procedure.Schema)(sampleProcedure),
        [field]: [entry],
      })._tag
    ).toBe('Left')
  })

  test('performedAge decodes to null — Age is an unregistered datatype', () => {
    const decoded = Schema.decodeUnknownSync(Procedure.Schema)({
      ...Schema.encodeSync(Procedure.Schema)(sampleProcedure),
      performedAge: { value: 30, unit: 'a', system: 'http://unitsofmeasure.org', code: 'a' },
    })
    expect(decoded.performedAge).toBeNull()
  })

  test('performedPeriod bounds re-encode as UTC instants, not the wire literal', () => {
    // Arrange — an offset-bearing start and a date-only end
    const wire = {
      ...Schema.encodeSync(Procedure.Schema)(sampleProcedure),
      performedPeriod: { start: '2026-09-30T18:00:00-04:00', end: '2026-09-30' },
    }

    // Act
    const reEncoded = Schema.encodeSync(Procedure.Schema)(
      Schema.decodeUnknownSync(Procedure.Schema)(wire)
    )

    // Assert
    expect(reEncoded.performedPeriod).toMatchObject({
      start: '2026-09-30T22:00:00.000Z',
      end: '2026-09-30T00:00:00.000Z',
    })
  })

  test('property: status round-trips', () => {
    fc.assert(
      fc.property(overrideArb({ status: Procedure.StatusSchema }), (override) =>
        roundTrip({ ...sampleProcedure, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: identifier[] round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          identifier: Schema.Array(IdentifierAndReference.IdentifierSchema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleProcedure, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: reference-array fields round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          basedOn: referenceArray,
          partOf: referenceArray,
          reasonReference: referenceArray,
          report: referenceArray,
          complicationDetail: referenceArray,
          usedReference: referenceArray,
        }),
        (override) => roundTrip({ ...sampleProcedure, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: single references round-trip', () => {
    const nullableReference = Schema.NullOr(IdentifierAndReference.ReferenceSchema)
    fc.assert(
      fc.property(
        overrideArb({
          subject: IdentifierAndReference.ReferenceSchema,
          encounter: nullableReference,
          recorder: nullableReference,
          asserter: nullableReference,
          location: nullableReference,
        }),
        (override) => roundTrip({ ...sampleProcedure, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: CodeableConcept fields round-trip', () => {
    const nullableCodeableConcept = Schema.NullOr(CodeableConcept.Schema)
    fc.assert(
      fc.property(
        overrideArb({
          statusReason: nullableCodeableConcept,
          category: nullableCodeableConcept,
          code: nullableCodeableConcept,
          outcome: nullableCodeableConcept,
          reasonCode: codeableConceptArray,
          bodySite: codeableConceptArray,
          complication: codeableConceptArray,
          followUp: codeableConceptArray,
          usedCode: codeableConceptArray,
        }),
        (override) => roundTrip({ ...sampleProcedure, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: performer[], focalDevice[] and note[] round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          performer: Schema.Array(ProcedurePerformer.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
          focalDevice: Schema.Array(ProcedureFocalDevice.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
          note: Schema.Array(Annotation.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
        }),
        (override) => roundTrip({ ...sampleProcedure, ...override })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: shell primitives round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          instantiatesCanonical: Schema.Array(Schema.String),
          instantiatesUri: Schema.Array(Schema.String),
          language: Schema.NullOr(Code),
          implicitRules: Schema.NullOr(Schema.URL),
          meta: Schema.NullOr(Meta.Schema),
        }),
        (override) => roundTrip({ ...sampleProcedure, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  // `performedAge` is left out: `Age` is an unregistered datatype, so its slot
  // only ever decodes to `null` (see "Unregistered choice-element datatypes"
  // in the Client Capabilities Reference).
  test('property: performed[x] choice field round-trips', () => {
    fc.assert(
      fc.property(
        atMostOnePopulatedSlot({
          performedDateTime: Schema.NullOr(Schema.DateTimeUtc),
          performedPeriod: Schema.NullOr(Period.Schema),
          performedString: Schema.NullOr(Schema.String),
          performedRange: Schema.NullOr(Range.Schema),
        }),
        (override) => roundTrip({ ...sampleProcedure, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  describe.each([
    {
      prefix: 'performed',
      slots: atLeastTwoPopulatedSlots({
        performedDateTime: Schema.DateTimeUtc,
        performedPeriod: Period.Schema,
        performedString: Schema.String,
        performedRange: Range.Schema,
      }),
    },
  ])('$prefix[x] at-most-one guard', ({ prefix, slots }) => {
    test('property: rejects decoding a wire procedure populating two or more slots', () => {
      fc.assert(
        fc.property(slots, (populated) => {
          // Arrange — each slot's wire JSON, merged onto the shell's
          const wire = {
            ...Schema.encodeSync(Procedure.Schema)(sampleProcedure),
            ...Object.fromEntries(
              populated.map(([key, value]) => [key, wireProcedureSlot(key, value)])
            ),
          }

          // Act
          const result = Schema.decodeUnknownEither(Procedure.Schema)(wire)

          // Assert
          expectChoiceElementGuardFailure(result, prefix, populated)
        }),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })

    test('property: rejects encoding a procedure populating two or more slots', () => {
      fc.assert(
        fc.property(slots, (populated) => {
          // Arrange
          const procedure = { ...sampleProcedure, ...Object.fromEntries(populated) }

          // Act
          const result = Schema.encodeEither(Procedure.Schema)(procedure)

          // Assert
          expectChoiceElementGuardFailure(result, prefix, populated)
        }),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })
  })
})

describe('ProcedureSearchParams', () => {
  test('carries every declared parameter through the wire unchanged', () => {
    // Arrange
    const query = {
      _count: '20',
      _pageToken: 'opaque-server-token',
      _id: 'workout-1',
      identifier: 'http://example.com/workouts|w-1',
      status: 'completed',
      code: 'http://snomed.info/sct|229065009',
      subject: 'Patient/p-1',
      patient: 'p-1',
      date: 'ge2026-09-01',
      'based-on': 'ServiceRequest/squat',
      'part-of': 'Procedure/program-1',
      category: 'http://snomed.info/sct|229065009',
    }

    // Act
    const reEncoded = Schema.encodeSync(SearchParams)(Schema.decodeUnknownSync(SearchParams)(query))

    // Assert
    expect(reEncoded).toEqual(query)
  })

  test.each([
    { reason: 'a status outside the Procedure value set', query: { status: 'active' } },
    { reason: 'a _count above the 1000 page ceiling', query: { _count: '1001' } },
    { reason: 'a date with an unknown prefix', query: { date: 'xx2026' } },
  ])('rejects $reason', ({ query }) => {
    expect(Schema.decodeUnknownEither(SearchParams)(query)._tag).toBe('Left')
  })
})

// Helpers

// The wire JSON of one top-level choice slot, encoded through the whole
// procedure.
const wireProcedureSlot = (key: string, value: unknown): unknown => {
  const encoded: Readonly<Record<string, unknown>> = {
    ...Schema.encodeSync(Procedure.Schema)({ ...sampleProcedure, [key]: value }),
  }
  return encoded[key]
}
