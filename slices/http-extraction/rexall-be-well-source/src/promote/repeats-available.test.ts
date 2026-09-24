import * as fc from 'fast-check'
import { WildflowerExtension } from 'fhir-r4/data-types'
import { MedicationRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { CarebookExtension } from '../carebook.ts'
import { promoteMedicationRequest } from './medication-request.ts'
import { emptyDispenseRequest, extensionWith, repeatsModifiers, urlsOf } from './test-helpers.ts'

describe('promoteMedicationRequest', () => {
  it('should consume both remaining-repeats copies into one Wildflower valueInteger', () => {
    fc.assert(
      fc.property(fc.nat({ max: 99 }), (count) => {
        // Arrange — the dialect's dual write, as the capture carries it.
        const request = {
          ...MedicationRequest.empty,
          dispenseRequest: {
            ...emptyDispenseRequest,
            modifierExtension: repeatsModifiers({ v1: count, v2: count }),
          },
        }

        // Act
        const promoted = promoteMedicationRequest(request)

        // Assert
        expect(promoted.dispenseRequest?.modifierExtension).toEqual([])
        expect(promoted.dispenseRequest?.extension).toEqual([
          extensionWith(WildflowerExtension.RepeatsAvailable, { valueInteger: count }),
        ])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should leave a remaining-repeats copy that is not a whole count in place', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Number.isInteger(n)),
          fc.integer({ max: -1 })
        ),
        (malformed) => {
          // Arrange — only the v2 decimal copy, and it is no repeat count.
          const request = {
            ...MedicationRequest.empty,
            dispenseRequest: {
              ...emptyDispenseRequest,
              modifierExtension: repeatsModifiers({ v2: malformed }),
            },
          }

          // Act
          const promoted = promoteMedicationRequest(request)

          // Assert
          expect(promoted.dispenseRequest).toEqual(request.dispenseRequest)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should keep a v2 remaining-repeats copy that disagrees with the v1 value it promoted', () => {
    // Arrange — the two copies are supposed to be equal; when they are not, the
    // v1 integer wins and the v2 value nobody promoted stays.
    const request = {
      ...MedicationRequest.empty,
      dispenseRequest: {
        ...emptyDispenseRequest,
        modifierExtension: repeatsModifiers({ v1: 2, v2: 3 }),
      },
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(urlsOf(promoted.dispenseRequest?.modifierExtension ?? [])).toEqual([
      CarebookExtension.NumberOfRepeatsAvailableV2,
    ])
    expect(promoted.dispenseRequest?.extension[0]?.valueInteger).toBe(2)
  })
})
