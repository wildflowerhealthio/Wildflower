import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Coding from './coding.ts'

const codingArb = Arbitrary.make(Coding.Coding)

describe('Coding model', () => {
  test('Coding.ResourceType is "Coding"', () => {
    expect(Coding.Coding.ResourceType).toBe('Coding')
  })

  test('Coding.IdSchema is defined', () => {
    expect(Coding.Coding.IdSchema).toBeDefined()
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(codingArb, (coding) => {
        const encoded = Schema.encodeSync(Coding.Coding)(coding)
        const decoded = Schema.decodeSync(Coding.Coding)(encoded)
        expect(decoded).toSchemaEqual(coding)
      })
    )
  })
})
