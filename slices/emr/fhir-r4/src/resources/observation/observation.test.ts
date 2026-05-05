import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Observation as StoreObservation } from 'emr-core/livestore'

import * as Observation from './observation.ts'

// ---------------------------------------------------------------------------
// Decomposed wire-format proof.
//
// Round-tripping `Arbitrary.make(StoreObservation.RowSchema)` walks the full
// graph (Reference → Identifier, CodeableConcept[] each with Coding[], plus
// the Observation.value[x] choice element). The store-side `RowSchema`
// arbitrary further normalises every iteration via an inner encode/decode
// pass, doubling the per-iteration cost. Together those drove the test past
// any reasonable timeout under fast-check's default 100 runs.
//
// The wire-format proof is preserved by decomposing into one property per
// column: each iteration generates only that column's content (via
// `RowSchema.pick(field)`), spreads it onto a fixed shell observation, and
// encodes/decodes the WHOLE observation through `Observation.Schema` — so
// the fhir-r4 adapter is still exercised end-to-end. Generation cost is now
// O(field) per iteration.
// ---------------------------------------------------------------------------

const sampleObservation: typeof StoreObservation.RowSchema.Type = {
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

const roundTrip = (observation: typeof StoreObservation.RowSchema.Type): void => {
  const fhir = Schema.encodeSync(Observation.Schema)(observation)
  const decoded = Schema.decodeSync(Observation.Schema)(fhir)
  expect(decoded).toSchemaEqual(StoreObservation.RowSchema, observation)
}

const fieldArb = <const K extends keyof typeof StoreObservation.RowSchema.Type>(
  field: K
): fc.Arbitrary<Pick<typeof StoreObservation.RowSchema.Type, K>> =>
  // `Schema.Struct.pick` returns a struct whose Type is structurally
  // `Pick<T, K>` but written as a mapped type that TS can't reduce; we
  // widen through `unknown` so the public signature stays clean.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment
  Arbitrary.make(StoreObservation.RowSchema.pick(field)) as unknown as fc.Arbitrary<
    Pick<typeof StoreObservation.RowSchema.Type, K>
  >

describe('FhirR4Observation', () => {
  test('encode-decode round-trip with shell observation', () => {
    roundTrip(sampleObservation)
  })

  test('property: code field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('code'), (override) => roundTrip({ ...sampleObservation, ...override }))
    )
  })

  test('property: status field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('status'), (override) =>
        roundTrip({ ...sampleObservation, ...override })
      )
    )
  })

  test('property: identifier field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('identifier'), (override) =>
        roundTrip({ ...sampleObservation, ...override })
      )
    )
  })

  test('property: category field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('category'), (override) =>
        roundTrip({ ...sampleObservation, ...override })
      )
    )
  })

  test('property: interpretation field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('interpretation'), (override) =>
        roundTrip({ ...sampleObservation, ...override })
      )
    )
  })

  test('property: note field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('note'), (override) => roundTrip({ ...sampleObservation, ...override }))
    )
  })

  test('property: component field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('component'), (override) =>
        roundTrip({ ...sampleObservation, ...override })
      )
    )
  })

  test('property: referenceRange field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('referenceRange'), (override) =>
        roundTrip({ ...sampleObservation, ...override })
      )
    )
  })

  test('property: reference fields round-trip (basedOn / derivedFrom / focus / hasMember / partOf / performer)', () => {
    const arb = Arbitrary.make(
      StoreObservation.RowSchema.pick(
        'basedOn',
        'derivedFrom',
        'focus',
        'hasMember',
        'partOf',
        'performer'
      )
    )
    fc.assert(fc.property(arb, (override) => roundTrip({ ...sampleObservation, ...override })))
  })

  test('property: nullable single references round-trip (subject / encounter / device / specimen)', () => {
    const arb = Arbitrary.make(
      StoreObservation.RowSchema.pick('subject', 'encounter', 'device', 'specimen')
    )
    fc.assert(fc.property(arb, (override) => roundTrip({ ...sampleObservation, ...override })))
  })

  test('property: nullable single CodeableConcepts round-trip (bodySite / dataAbsentReason / method)', () => {
    const arb = Arbitrary.make(
      StoreObservation.RowSchema.pick('bodySite', 'dataAbsentReason', 'method')
    )
    fc.assert(fc.property(arb, (override) => roundTrip({ ...sampleObservation, ...override })))
  })

  test('property: shell primitives round-trip', () => {
    const shellArb = Arbitrary.make(
      StoreObservation.RowSchema.pick('issued', 'language', 'implicitRules', 'meta')
    )
    fc.assert(fc.property(shellArb, (override) => roundTrip({ ...sampleObservation, ...override })))
  })

  test('property: effective[x] choice field round-trips', () => {
    const effectiveArb = Arbitrary.make(
      StoreObservation.RowSchema.pick(
        'effectiveDateTime',
        'effectivePeriod',
        'effectiveTiming',
        'effectiveInstant'
      )
    )
    fc.assert(
      fc.property(effectiveArb, (override) => roundTrip({ ...sampleObservation, ...override }))
    )
  })

  test('property: value[x] choice field round-trips', () => {
    const valueArb = Arbitrary.make(
      StoreObservation.RowSchema.pick(
        'valueQuantity',
        'valueCodeableConcept',
        'valueString',
        'valueBoolean',
        'valueInteger',
        'valueRange',
        'valueRatio',
        'valueSampledData',
        'valueTime',
        'valueDateTime',
        'valuePeriod'
      )
    )
    fc.assert(fc.property(valueArb, (override) => roundTrip({ ...sampleObservation, ...override })))
  })
})
