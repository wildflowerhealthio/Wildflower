import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Annotation from './annotation.ts'

// ---------------------------------------------------------------------------
// Annotation has an `author[x]` choice (`authorString` / `authorReference`),
// and `authorReference` walks the Reference→Identifier cycle. Round-tripping
// the full schema repeatedly recurses through both. Decompose into per-field
// properties; the FHIR wire-format proof is still exercised by the whole
// schema's encode/decode on every iteration.
// ---------------------------------------------------------------------------

const sampleAnnotation: typeof Annotation.Schema.Type = {
  id: null,
  extension: [],
  authorString: null,
  authorReference: null,
  time: null,
  text: '',
}

const roundTrip = (annotation: typeof Annotation.Schema.Type): void => {
  const fhir = Schema.encodeSync(Annotation.Schema)(annotation)
  const decoded = Schema.decodeSync(Annotation.Schema)(fhir)
  expect(decoded).toSchemaEqual(Annotation.Schema, annotation)
}

// `Schema.pick`'s `Keys` generic can't be inferred from a curried call site
// (`Schema.pick(field)(schema)` resolves `A`/`I` to `unknown` before `schema`
// is seen), so this local wrapper pins `A`/`I`/`Keys` explicitly from a
// single call.
const pickField = <A, I, R, K extends keyof A & keyof I>(
  schema: Schema.Schema<A, I, R>,
  field: K
): Schema.Schema<Pick<A, K>, Pick<I, K>, R> => Schema.pick<A, I, [K]>(field)(schema)

const fieldArb = <const K extends keyof typeof Annotation.Schema.Type>(
  field: K
): fc.Arbitrary<Pick<typeof Annotation.Schema.Type, K>> =>
  Arbitrary.make(pickField(Annotation.Schema, field))

describe('FhirR4Annotation', () => {
  test('round-trips empty shell', () => {
    roundTrip(sampleAnnotation)
  })

  test('property: text field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('text'), (o) => roundTrip({ ...sampleAnnotation, ...o })),
      {
        numRuns: numRunsFor({ base: 100 }),
      }
    )
  })

  test('property: time field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('time'), (o) => roundTrip({ ...sampleAnnotation, ...o })),
      {
        numRuns: numRunsFor({ base: 100 }),
      }
    )
  })

  test('property: authorString field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('authorString'), (o) => roundTrip({ ...sampleAnnotation, ...o })),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: authorReference field round-trips (Reference→Identifier cycle)', () => {
    fc.assert(
      fc.property(fieldArb('authorReference'), (o) => roundTrip({ ...sampleAnnotation, ...o })),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
