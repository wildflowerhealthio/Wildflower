import * as fc from 'fast-check'
import { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { promoteMedicationDispense } from './medication-dispense.ts'
import { promoteMedicationRequest } from './medication-request.ts'
import { emptyDispenseRequest, emptyQuantity } from './test-helpers.ts'

describe('promoteMedicationRequest', () => {
  it('should spell out the day unit on a bare expectedSupplyDuration', () => {
    // Arrange — Rexall sends `{ value }` with no unit; the value is in days.
    const request = {
      ...MedicationRequest.empty,
      dispenseRequest: {
        ...emptyDispenseRequest,
        expectedSupplyDuration: { ...emptyQuantity, value: 30 },
      },
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.dispenseRequest?.expectedSupplyDuration).toMatchObject({
      value: 30,
      unit: 'day',
      code: 'd',
      system: 'http://unitsofmeasure.org',
    })
  })

  it('should never overwrite a supply duration that already names its own unit', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.integer({ min: 1 }), (unit, value) => {
        // Arrange
        const request = {
          ...MedicationRequest.empty,
          dispenseRequest: {
            ...emptyDispenseRequest,
            expectedSupplyDuration: { ...emptyQuantity, value, unit },
          },
        }

        // Act
        const promoted = promoteMedicationRequest(request)

        // Assert
        expect(promoted.dispenseRequest?.expectedSupplyDuration?.unit).toBe(unit)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('promoteMedicationDispense', () => {
  it('should spell out the day unit on a bare daysSupply', () => {
    // Arrange
    const dispense = {
      ...MedicationDispense.empty,
      daysSupply: { ...emptyQuantity, value: 90 },
    }

    // Act
    const promoted = promoteMedicationDispense(dispense)

    // Assert
    expect(promoted.daysSupply).toMatchObject({ value: 90, unit: 'day', code: 'd' })
  })
})
