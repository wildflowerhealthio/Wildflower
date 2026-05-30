import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as CodeableConcept from './codeable-concept.ts'

const codeableConceptArb = Arbitrary.make(CodeableConcept.Schema)

describe('CodeableConcept model', () => {
  test('CodeableConcept.ResourceType is "CodeableConcept"', () => {
    expect(CodeableConcept.ResourceType).toBe('CodeableConcept')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(codeableConceptArb, (codeableConcept) => {
        const encoded = Schema.encodeSync(CodeableConcept.Schema)(codeableConcept)
        const decoded = Schema.decodeSync(CodeableConcept.Schema)(encoded)
        expect(decoded).toSchemaEqual(CodeableConcept.Schema, codeableConcept)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
