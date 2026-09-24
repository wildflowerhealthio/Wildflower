import * as fc from 'fast-check'
import { Code } from 'fhir-r4/data-types'
import { MedicationRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { CarebookCodingSystem, CarebookExtension } from '../carebook.ts'
import { promoteMedicationRequest } from './medication-request.ts'
import {
  containedMedication,
  emptyDispenseRequest,
  emptyQuantity,
  extensionWith,
  repeatsModifiers,
  storeExtensions,
  unrelatedUrl,
  urlsOf,
} from './test-helpers.ts'

describe('promoteMedicationRequest', () => {
  it('should move do-not-perform into the R4 doNotPerform field', () => {
    // Arrange
    const request = {
      ...MedicationRequest.empty,
      extension: [extensionWith(CarebookExtension.DoNotPerform, { valueBoolean: true })],
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.doNotPerform).toBe(true)
    expect(urlsOf(promoted.extension)).toEqual([])
  })

  it('should move request-type into category, preserving the carebook coding', () => {
    // Arrange
    const request = {
      ...MedicationRequest.empty,
      extension: [
        extensionWith(CarebookExtension.RequestType, {
          valueCodeableConcept: {
            id: null,
            extension: [],
            text: null,
            coding: [
              {
                id: null,
                extension: [],
                code: Code.make('refill'),
                display: null,
                // `Coding.system` decodes to a `URL` instance, not a string.
                system: new URL(CarebookCodingSystem.RequestType),
                userSelected: null,
                version: null,
              },
            ],
          },
        }),
      ],
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.category[0]?.coding[0]?.code).toBe('refill')
    expect(urlsOf(promoted.extension)).toEqual([])
  })

  it('should keep a second copy of a url whose value it never read', () => {
    // Arrange — the dialect writes some urls twice. Only the first is read, so
    // consuming by url rather than by entry would delete an unexamined value.
    const request = {
      ...MedicationRequest.empty,
      extension: [
        extensionWith(CarebookExtension.DoNotPerform, { valueBoolean: true }),
        extensionWith(CarebookExtension.DoNotPerform, { valueBoolean: false }),
      ],
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.doNotPerform).toBe(true)
    expect(promoted.extension).toHaveLength(1)
    expect(promoted.extension[0]?.valueBoolean).toBe(false)
  })

  it('should never drop an extension it does not promote', () => {
    fc.assert(
      fc.property(fc.array(unrelatedUrl, { minLength: 1 }), (urls) => {
        // Arrange
        const request = {
          ...MedicationRequest.empty,
          extension: urls.map((url) => extensionWith(url, { valueString: 'kept' })),
        }

        // Act
        const promoted = promoteMedicationRequest(request)

        // Assert
        expect(urlsOf(promoted.extension)).toEqual(urls)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always be idempotent — a second promotion changes nothing', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.array(unrelatedUrl), (doNotPerform, extras) => {
        // Arrange
        const request = {
          ...MedicationRequest.empty,
          contained: [containedMedication({ id: 'med-1', strength: '5 mg', description: 'Drug' })],
          extension: [
            extensionWith(CarebookExtension.DoNotPerform, { valueBoolean: doNotPerform }),
            ...storeExtensions(CarebookExtension.RequestExternalStoreId, '4821'),
            ...extras.map((url) => extensionWith(url, { valueString: 'kept' })),
          ],
          dispenseRequest: {
            ...emptyDispenseRequest,
            modifierExtension: repeatsModifiers({ v1: 2, v2: 2 }),
            expectedSupplyDuration: { ...emptyQuantity, value: 30 },
          },
        }

        // Act
        const once = promoteMedicationRequest(request)
        const twice = promoteMedicationRequest(once)

        // Assert
        expect(twice).toEqual(once)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
