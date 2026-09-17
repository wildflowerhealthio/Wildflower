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

  it('should reject a reference to any other resource type, and an empty id', () => {
    expect(SourceFile.isReference('Patient/p-1')).toBe(false)
    expect(SourceFile.isReference('DocumentReference/')).toBe(false)
    expect(SourceFile.isReference('')).toBe(false)
  })

  it('should accept a well-formed DocumentReference reference', () => {
    expect(SourceFile.isReference('DocumentReference/doc-1')).toBe(true)
  })
})
