import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { Annotation as StoreAnnotation } from 'emr-core/schemas'

import * as Annotation from './annotation.ts'

// ---------------------------------------------------------------------------
// Annotation has an `author[x]` choice (`authorString` / `authorReference`),
// and `authorReference` walks the Reference→Identifier cycle. Round-tripping
// the full schema repeatedly recurses through both. Decompose into per-field
// properties; the FHIR wire-format proof is still exercised by the whole
// schema's encode/decode on every iteration.
// ---------------------------------------------------------------------------

const sampleAnnotation: typeof StoreAnnotation.Schema.Type = {
  id: null,
  extension: [],
  authorString: null,
  authorReference: null,
  time: null,
  text: '',
}

const roundTrip = (annotation: typeof StoreAnnotation.Schema.Type): void => {
  const fhir = Schema.encodeSync(Annotation.Schema)(annotation)
  const decoded = Schema.decodeSync(Annotation.Schema)(fhir)
  expect(decoded).toSchemaEqual(StoreAnnotation.Schema, annotation)
}

const fieldArb = <const K extends keyof typeof StoreAnnotation.Schema.Type>(
  field: K
): fc.Arbitrary<Pick<typeof StoreAnnotation.Schema.Type, K>> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see fhir-r4 patient.test.ts header
  Arbitrary.make(StoreAnnotation.Schema.pick(field)) as unknown as fc.Arbitrary<
    Pick<typeof StoreAnnotation.Schema.Type, K>
  >

describe('FhirR4Annotation', () => {
  test('round-trips empty shell', () => {
    roundTrip(sampleAnnotation)
  })

  test('property: text field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('text'), (o) => roundTrip({ ...sampleAnnotation, ...o })),
      {
        numRuns: numRunsFor(100),
      }
    )
  })

  test('property: time field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('time'), (o) => roundTrip({ ...sampleAnnotation, ...o })),
      {
        numRuns: numRunsFor(100),
      }
    )
  })

  test('property: authorString field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('authorString'), (o) => roundTrip({ ...sampleAnnotation, ...o })),
      { numRuns: numRunsFor(100) }
    )
  })

  test('property: authorReference field round-trips (Reference→Identifier cycle)', () => {
    fc.assert(
      fc.property(fieldArb('authorReference'), (o) => roundTrip({ ...sampleAnnotation, ...o })),
      { numRuns: numRunsFor(100) }
    )
  })
})
