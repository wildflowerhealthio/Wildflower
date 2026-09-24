import { Arbitrary, Either, type ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { atMostOnePopulatedSlot } from '../../data-types/base/choice-element-passthrough-fields.test-helpers.ts'
import { InstantSchema, TimeSchema } from '../../data-types/base/primitives.ts'
import {
  Annotation,
  Code,
  CodeableConcept,
  IdentifierAndReference,
  Meta,
  Period,
  Quantity,
  Range,
  Ratio,
  SampledData,
  Timing,
} from '../../data-types/index.ts'
import * as ObservationComponent from './observation-component.ts'
import * as ObservationReferenceRange from './observation-reference-range.ts'
import * as Observation from './observation.ts'

// ---------------------------------------------------------------------------
// Decomposed wire-format proof.
//
// Round-tripping an arbitrary over the whole Observation schema walks the
// full graph (Reference → Identifier, CodeableConcept[] each with Coding[],
// plus the Observation.value[x] choice element). That drove the test past
// any reasonable timeout under fast-check's default 100 runs.
//
// The wire-format proof is preserved by decomposing into one property per
// field: each iteration generates only that field's content (from the same
// component schema the Observation struct embeds), spreads it onto a fixed
// shell observation, and encodes/decodes the WHOLE observation through
// `Observation.Schema` — so the wire schema is still exercised end-to-end.
// Generation cost is O(field) per iteration.
// ---------------------------------------------------------------------------

const sampleObservation: typeof Observation.Schema.Type = {
  resourceType: 'Observation',
  id: 'obs-id',
  meta: {
    versionId: '',
    lastUpdated: null,
    source: '',
    profile: [],
    security: [],
    tag: [],
  },
  implicitRules: null,
  language: null,
  text: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  basedOn: [],
  bodySite: null,
  category: [],
  code: { id: null, extension: [], coding: [], text: null },
  component: [],
  dataAbsentReason: null,
  derivedFrom: [],
  device: null,
  effectiveDateTime: null,
  effectivePeriod: null,
  effectiveTiming: null,
  effectiveInstant: null,
  encounter: null,
  focus: [],
  hasMember: [],
  identifier: [],
  interpretation: [],
  issued: null,
  method: null,
  note: [],
  partOf: [],
  performer: [],
  referenceRange: [],
  specimen: null,
  status: 'final',
  subject: null,
  valueQuantity: null,
  valueCodeableConcept: null,
  valueString: null,
  valueBoolean: null,
  valueInteger: null,
  valueRange: null,
  valueRatio: null,
  valueSampledData: null,
  valueTime: null,
  valueDateTime: null,
  valuePeriod: null,
}

const roundTrip = (observation: typeof Observation.Schema.Type): void => {
  const fhir = Schema.encodeSync(Observation.Schema)(observation)
  const decoded = Schema.decodeSync(Observation.Schema)(fhir)
  expect(decoded).toSchemaEqual(Observation.Schema, observation)
}

// Generates decoded overrides for a set of Observation fields from the same
// component schemas the Observation struct embeds. The struct's decoded field
// types are exactly the component schemas' Types, so the generated record
// spreads straight over `sampleObservation` (mistyped overrides surface as a
// type error on the spread inside `roundTrip`'s callsite).
const overrideArb = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Schema.Type<Schema.Struct<Fields>>> => Arbitrary.make(Schema.Struct(fields))

describe('FhirR4Observation', () => {
  test('encode-decode round-trip with shell observation', () => {
    roundTrip(sampleObservation)
  })

  test('property: code field round-trips', () => {
    fc.assert(
      fc.property(overrideArb({ code: CodeableConcept.Schema }), (override) =>
        roundTrip({ ...sampleObservation, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: status field round-trips', () => {
    fc.assert(
      fc.property(overrideArb({ status: Observation.StatusSchema }), (override) =>
        roundTrip({ ...sampleObservation, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  describe('value[x] at-most-one guard', () => {
    test('property: rejects decoding a wire payload populating two or more value[x] slots', () => {
      fc.assert(
        fc.property(conflictingValueSlotsArb, (slots) => {
          // Arrange — each slot's wire JSON, merged onto the shell observation's
          const wire = {
            ...Schema.encodeSync(Observation.Schema)(sampleObservation),
            ...Object.fromEntries(slots.map(([key, value]) => [key, wireSlot(key, value)])),
          }

          // Act
          const result = Schema.decodeUnknownEither(Observation.Schema)(wire)

          // Assert
          expectGuardFailureNaming(result, slots)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    test('property: rejects encoding an Observation populating two or more value[x] slots', () => {
      fc.assert(
        fc.property(conflictingValueSlotsArb, (slots) => {
          // Arrange
          const observation = { ...sampleObservation, ...Object.fromEntries(slots) }

          // Act
          const result = Schema.encodeEither(Observation.Schema)(observation)

          // Assert
          expectGuardFailureNaming(result, slots)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })

  describe('status leniency (client capability deviation)', () => {
    // Minimal FHIR wire Observation — required per FHIR is resourceType +
    // code + status, but this suite exercises what happens when `status`
    // is absent / malformed on the wire.
    const wireObservation = (extra: Record<string, unknown>): Record<string, unknown> => ({
      resourceType: 'Observation',
      id: 'obs-1',
      code: { coding: [], text: 'Heart rate' },
      ...extra,
    })

    test('a MISSING status decodes to the `unknown` sentinel', () => {
      const decoded = Schema.decodeUnknownSync(Observation.Schema)(wireObservation({}))
      expect(decoded.status).toBe('unknown')
    })

    test('a PRESENT valid status is preserved (not overwritten by the default)', () => {
      const decoded = Schema.decodeUnknownSync(Observation.Schema)(
        wireObservation({ status: 'final' })
      )
      expect(decoded.status).toBe('final')
    })

    test('a PRESENT but unrecognized status still fails to decode', () => {
      expect(() =>
        Schema.decodeUnknownSync(Observation.Schema)(wireObservation({ status: 'bogus' }))
      ).toThrow()
    })

    test('a PRESENT null status still fails to decode (absence is rescued, a bad value is not)', () => {
      expect(() =>
        Schema.decodeUnknownSync(Observation.Schema)(wireObservation({ status: null }))
      ).toThrow()
    })
  })

  test('property: identifier field round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          identifier: Schema.Array(IdentifierAndReference.IdentifierSchema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleObservation, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: category field round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          category: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleObservation, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: interpretation field round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          interpretation: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleObservation, ...override })
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
        (override) => roundTrip({ ...sampleObservation, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: component field round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          component: Schema.Array(ObservationComponent.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleObservation, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: referenceRange field round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          referenceRange: Schema.Array(ObservationReferenceRange.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleObservation, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: reference fields round-trip (basedOn / derivedFrom / focus / hasMember / partOf / performer)', () => {
    const references = Schema.Array(IdentifierAndReference.ReferenceSchema).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    )
    const arb = overrideArb({
      basedOn: references,
      derivedFrom: references,
      focus: references,
      hasMember: references,
      partOf: references,
      performer: references,
    })
    fc.assert(
      fc.property(arb, (override) => roundTrip({ ...sampleObservation, ...override })),
      {
        numRuns: numRunsFor({ base: 100 }),
      }
    )
  })

  test('property: nullable single references round-trip (subject / encounter / device / specimen)', () => {
    const reference = Schema.NullOr(IdentifierAndReference.ReferenceSchema)
    const arb = overrideArb({
      subject: reference,
      encounter: reference,
      device: reference,
      specimen: reference,
    })
    fc.assert(
      fc.property(arb, (override) => roundTrip({ ...sampleObservation, ...override })),
      {
        numRuns: numRunsFor({ base: 100 }),
      }
    )
  })

  test('property: nullable single CodeableConcepts round-trip (bodySite / dataAbsentReason / method)', () => {
    const codeableConcept = Schema.NullOr(CodeableConcept.Schema)
    const arb = overrideArb({
      bodySite: codeableConcept,
      dataAbsentReason: codeableConcept,
      method: codeableConcept,
    })
    fc.assert(
      fc.property(arb, (override) => roundTrip({ ...sampleObservation, ...override })),
      {
        numRuns: numRunsFor({ base: 100 }),
      }
    )
  })

  test('property: shell primitives round-trip', () => {
    const shellArb = overrideArb({
      issued: Schema.NullOr(Schema.DateTimeUtc),
      language: Schema.NullOr(Code),
      implicitRules: Schema.NullOr(Schema.URL),
      meta: Schema.NullOr(Meta.Schema),
    })
    fc.assert(
      fc.property(shellArb, (override) => roundTrip({ ...sampleObservation, ...override })),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: effective[x] choice field round-trips', () => {
    const effectiveArb = atMostOnePopulatedSlot({
      effectiveDateTime: Schema.NullOr(Schema.DateTimeUtc),
      effectivePeriod: Schema.NullOr(Period.Schema),
      effectiveTiming: Schema.NullOr(Timing.Schema),
      effectiveInstant: Schema.NullOr(InstantSchema),
    })
    fc.assert(
      fc.property(effectiveArb, (override) => roundTrip({ ...sampleObservation, ...override })),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: value[x] choice field round-trips', () => {
    const valueArb = atMostOnePopulatedSlot({
      valueQuantity: Schema.NullOr(Quantity.Schema),
      valueCodeableConcept: Schema.NullOr(CodeableConcept.Schema),
      valueString: Schema.NullOr(Schema.String),
      valueBoolean: Schema.NullOr(Schema.Boolean),
      valueInteger: Schema.NullOr(Schema.Int),
      valueRange: Schema.NullOr(Range.Schema),
      valueRatio: Schema.NullOr(Ratio.Schema),
      valueSampledData: Schema.NullOr(SampledData.Schema),
      valueTime: Schema.NullOr(TimeSchema),
      valueDateTime: Schema.NullOr(Schema.DateTimeUtc),
      valuePeriod: Schema.NullOr(Period.Schema),
    })
    fc.assert(
      fc.property(valueArb, (override) => roundTrip({ ...sampleObservation, ...override })),
      {
        numRuns: numRunsFor({ base: 100 }),
      }
    )
  })
})

// Helpers

// Two or more `Observation.value[x]` slots, each paired with a non-null
// decoded value — a choice element FHIR R4 forbids.
const conflictingValueSlotsArb = Arbitrary.make(
  Schema.Struct({
    valueQuantity: Quantity.Schema,
    valueCodeableConcept: CodeableConcept.Schema,
    valueString: Schema.String,
    valueBoolean: Schema.Boolean,
    valueInteger: Schema.Int,
    valueRange: Range.Schema,
    valueRatio: Ratio.Schema,
    valueSampledData: SampledData.Schema,
    valueTime: TimeSchema,
    valueDateTime: Schema.DateTimeUtc,
    valuePeriod: Period.Schema,
  })
).chain((values) => fc.subarray(Object.entries(values), { minLength: 2 }))

// The wire JSON of one `value[x]` slot, encoded through the whole Observation.
const wireSlot = (key: string, value: unknown): unknown => {
  const encoded: Readonly<Record<string, unknown>> = Schema.encodeSync(Observation.Schema)({
    ...sampleObservation,
    [key]: value,
  })
  return encoded[key]
}

const expectGuardFailureNaming = (
  result: Either.Either<unknown, ParseResult.ParseError>,
  slots: readonly (readonly [string, unknown])[]
): void => {
  const message = Either.match(result, {
    onLeft: (error) => error.message,
    onRight: () => 'succeeded without error',
  })
  expect(message).toContain(
    `choice element value[x] allows at most one populated slot, but found ${slots.length}:`
  )
  for (const [key] of slots) expect(message).toContain(key)
}
