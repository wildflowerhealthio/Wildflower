import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as SourceFile from './source-file.ts'

describe('SourceFile reference', () => {
  it('property: the id round-trips through makeReference/idFromReference', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (id) => {
        expect(SourceFile.idFromReference(SourceFile.makeReference(id))).toBe(id)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
