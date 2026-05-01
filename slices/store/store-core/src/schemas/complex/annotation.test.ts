import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Annotation from './annotation.ts'

const annotationArb = Arbitrary.make(Annotation.Schema)

describe('Annotation model', () => {
  // Annotation's author[x] choice element keeps this property test ~1.3s solo
  // and over 5s under the CPU contention of `vp run -r test`. Bumped for headroom.
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(annotationArb, (annotation) => {
        const encoded = Schema.encodeSync(Annotation.Schema)(annotation)
        const decoded = Schema.decodeSync(Annotation.Schema)(encoded)
        expect(decoded).toSchemaEqual(Annotation.Schema, annotation)
      })
    )
  }, 15_000)
})
