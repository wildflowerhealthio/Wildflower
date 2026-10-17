import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { FHIR_ID } from './ids.test-helpers.ts'
import { strongLiftsPlanDefinitionIdMinter } from './strong-lifts-plan-definition-id-minter.ts'

describe('strongLiftsPlanDefinitionIdMinter', () => {
  it('should name one lifter’s template with one FHIR id on every call', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (patientId) => {
        const mintFor = strongLiftsPlanDefinitionIdMinter()
        const first = mintFor(patientId)
        expect(first).toMatch(FHIR_ID)
        expect(mintFor(patientId)).toBe(first)
      })
    )
  })

  it('should name two lifters’ templates apart', () => {
    const mintFor = strongLiftsPlanDefinitionIdMinter()
    expect(mintFor('pat-1')).not.toBe(mintFor('pat-2'))
  })
})
