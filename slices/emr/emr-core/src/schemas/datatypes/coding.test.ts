import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Coding from './coding.ts'

const codingArb = Arbitrary.make(Coding.Schema)

describe('Coding model', () => {
  test('Coding.ResourceType is "Coding"', () => {
    expect(Coding.ResourceType).toBe('Coding')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(codingArb, (coding) => {
        const encoded = Schema.encodeSync(Coding.Schema)(coding)
        const decoded = Schema.decodeSync(Coding.Schema)(encoded)
        expect(decoded).toSchemaEqual(Coding.Schema, coding)
      }),
      { numRuns: numRunsFor(100) }
    )
  })
})
