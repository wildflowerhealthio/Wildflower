import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as PickedFileSource from './picked-file-source.ts'
import * as SourceFileFhirReference from './source-file-fhir-reference.ts'

describe('SourceFileFhirReference', () => {
  it('property: the id round-trips through make/idOf', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (id) => {
        expect(SourceFileFhirReference.idOf(SourceFileFhirReference.make(id))).toBe(id)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should reject a reference to any other resource type, and an empty id', () => {
    expect(SourceFileFhirReference.is('Patient/p-1')).toBe(false)
    expect(SourceFileFhirReference.is('DocumentReference/')).toBe(false)
    expect(SourceFileFhirReference.is('')).toBe(false)
  })

  it('should accept a well-formed DocumentReference reference', () => {
    expect(SourceFileFhirReference.is('DocumentReference/doc-1')).toBe(true)
  })
})

describe('PickedFileSource', () => {
  it('should build a server source carrying the reference form of the id', () => {
    expect(PickedFileSource.server('doc-9')).toEqual({
      _tag: 'server',
      reference: 'DocumentReference/doc-9',
    })
  })
})
