import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { serverSource, sourceFileIdOf, sourceFileReference } from './picked-file.ts'

describe('sourceFileReference / sourceFileIdOf', () => {
  it('property: the id round-trips through the reference form', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (id) => {
        expect(sourceFileIdOf(sourceFileReference(id))).toBe(id)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should reject a reference to any other resource type, and an empty id', () => {
    expect(sourceFileIdOf('Patient/p-1')).toBeUndefined()
    expect(sourceFileIdOf('DocumentReference/')).toBeUndefined()
    expect(sourceFileIdOf('')).toBeUndefined()
  })

  it('should build a server source carrying the reference form of the id', () => {
    expect(serverSource('doc-9')).toEqual({
      _tag: 'server',
      reference: 'DocumentReference/doc-9',
    })
  })
})
