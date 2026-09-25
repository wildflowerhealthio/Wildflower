import * as fc from 'fast-check'
import { MedicationDispense } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { CarebookExtension } from '../carebook.ts'
import { promoteMedicationDispense } from './medication-dispense.ts'
import {
  containedMedication,
  decodedVendorDinConcept,
  emptyQuantity,
  extensionWith,
  referenceTo,
  storeExtensions,
  unrelatedUrl,
  urlsOf,
} from './test-helpers.ts'

describe('promoteMedicationDispense', () => {
  it('should always be idempotent — a second promotion changes nothing', () => {
    fc.assert(
      fc.property(fc.array(unrelatedUrl), (extras) => {
        // Arrange
        const dispense = {
          ...MedicationDispense.empty,
          contained: [containedMedication({ id: 'med-1', strength: '5 mg', description: 'Drug' })],
          extension: [
            extensionWith(CarebookExtension.DispenseMedicationProcessor, {
              valueReference: referenceTo('pharmacy-4821'),
            }),
            ...storeExtensions(CarebookExtension.DispenseExternalStoreId, '4821'),
            ...extras.map((url) => extensionWith(url, { valueString: 'kept' })),
          ],
          medicationCodeableConcept: decodedVendorDinConcept('02241497'),
          daysSupply: { ...emptyQuantity, value: 90 },
        }

        // Act
        const once = promoteMedicationDispense(dispense)
        const twice = promoteMedicationDispense(once)

        // Assert
        expect(twice).toEqual(once)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never drop an extension it does not promote', () => {
    fc.assert(
      fc.property(fc.array(unrelatedUrl, { minLength: 1 }), (urls) => {
        // Arrange
        const dispense = {
          ...MedicationDispense.empty,
          extension: urls.map((url) => extensionWith(url, { valueString: 'kept' })),
        }

        // Act
        const promoted = promoteMedicationDispense(dispense)

        // Assert
        expect(urlsOf(promoted.extension)).toEqual(urls)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
