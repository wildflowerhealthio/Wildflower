import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Annotation from './annotation.ts'

const annotationArb = Arbitrary.make(Annotation.Schema)

describe('Annotation model', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(annotationArb, (annotation) => {
        const encoded = Schema.encodeSync(Annotation.Schema)(annotation)
        const decoded = Schema.decodeSync(Annotation.Schema)(encoded)
        expect(decoded).toSchemaEqual(Annotation.Schema, annotation)
      })
    )
  })
})
