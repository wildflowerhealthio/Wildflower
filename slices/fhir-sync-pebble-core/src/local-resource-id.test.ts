import * as FhirIdentity from '@wildflowerhealthio/fhir-r4/identity'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { joinIdComponents, localResourceId } from './local-resource-id.ts'

/**
 * Inputs reaching every UTF-8 length, surrogate pairs and lone surrogates, and
 * the separator characters `joinIdComponents` has to keep apart.
 */
const componentArbitrary = fc
  .array(
    fc.oneof(
      fc.constantFrom('a', ':', '1', 'é', '€', '😀', '\ud800', '\udc00'),
      fc.string({ unit: 'binary', maxLength: 4 })
    ),
    { maxLength: 12 }
  )
  .map((pieces) => pieces.join(''))

// The port is only worth having if it is fhir-r4's derivation exactly: the ids
// the phone writes must be the ones fhir-r4 would derive from the same inputs.
describe('localResourceId', () => {
  it("should derive fhir-r4's id for any inputs", () => {
    fc.assert(
      fc.property(
        componentArbitrary,
        componentArbitrary,
        componentArbitrary,
        (system, resourceType, originalId) => {
          expect(localResourceId(system, resourceType, originalId)).toBe(
            FhirIdentity.localResourceId(system, resourceType, originalId)
          )
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should always be wf- and 32 hex digits, a valid FHIR id', () => {
    fc.assert(
      fc.property(componentArbitrary, componentArbitrary, (system, originalId) => {
        expect(localResourceId(system, 'Observation', originalId)).toMatch(/^wf-[0-9a-f]{32}$/)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('joinIdComponents', () => {
  it("should fold components as fhir-r4's does", () => {
    fc.assert(
      fc.property(fc.array(componentArbitrary, { maxLength: 5 }), (components) => {
        expect(joinIdComponents(components)).toBe(FhirIdentity.joinIdComponents(components))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
