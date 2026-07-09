import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

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
    const effectiveArb = overrideArb({
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
    const valueArb = overrideArb({
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
