import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { exerciseIdArb } from './ids.test-helpers.ts'
import { serviceRequestIdMinter } from './service-request-id-minter.ts'

describe('serviceRequestIdMinter', () => {
  it('should name each exercise once, the same on a retry', () => {
    fc.assert(
      fc.property(fc.uniqueArray(exerciseIdArb, { maxLength: 8 }), (exerciseIds) => {
        const mintServiceRequestId = serviceRequestIdMinter()
        const firstIds = exerciseIds.map(mintServiceRequestId)
        expect(exerciseIds.map(mintServiceRequestId)).toEqual(firstIds)
        expect(new Set(firstIds).size).toBe(exerciseIds.length)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
