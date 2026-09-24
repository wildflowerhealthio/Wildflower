import * as fc from 'fast-check'
import { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { CarebookExtension, REXALL_SYSTEM_SOURCE } from '../carebook.ts'
import { promoteMedicationDispense } from './medication-dispense.ts'
import { promoteMedicationRequest } from './medication-request.ts'
import {
  emptyDispenseRequest,
  emptyReference,
  extensionWith,
  referenceTo,
  storeExtensions,
  unrelatedUrl,
  urlsOf,
} from './test-helpers.ts'

describe('promoteMedicationRequest', () => {
  it('should move medication-processor onto dispenseRequest.performer', () => {
    // Arrange
    const request = {
      ...MedicationRequest.empty,
      extension: [
        extensionWith(CarebookExtension.RequestMedicationProcessor, {
          valueReference: referenceTo('pharmacy-4821'),
        }),
      ],
      dispenseRequest: { ...emptyDispenseRequest },
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.dispenseRequest?.performer?.identifier?.value).toBe('pharmacy-4821')
    expect(urlsOf(promoted.extension)).toEqual([])
  })

  it('should keep medication-processor when there is no dispenseRequest to hold it', () => {
    // Arrange — `dispenseRequest` is optional in the dialect. With no
    // destination the value has nowhere to land, so dropping the extension
    // would destroy the dispensing pharmacy outright.
    const request = {
      ...MedicationRequest.empty,
      extension: [
        extensionWith(CarebookExtension.RequestMedicationProcessor, {
          valueReference: referenceTo('pharmacy-4821'),
        }),
      ],
      dispenseRequest: null,
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.dispenseRequest).toBeNull()
    expect(urlsOf(promoted.extension)).toEqual([CarebookExtension.RequestMedicationProcessor])
  })

  it('should put the store link on performer.reference, keeping the carebook pharmacy identifier', () => {
    fc.assert(
      fc.property(storeIdArbitrary, fc.array(unrelatedUrl), (storeId, extras) => {
        // Arrange
        const request = {
          ...MedicationRequest.empty,
          extension: [
            extensionWith(CarebookExtension.RequestMedicationProcessor, {
              valueReference: referenceTo('pharmacy-4821'),
            }),
            ...storeExtensions(CarebookExtension.RequestExternalStoreId, storeId),
            ...extras.map((url) => extensionWith(url, { valueString: 'kept' })),
          ],
          dispenseRequest: { ...emptyDispenseRequest },
        }

        // Act
        const promoted = promoteMedicationRequest(request)

        // Assert
        expect(promoted.dispenseRequest?.performer?.reference).toBe(
          `https://www.rexall.ca/storelocator/store/${encodeURIComponent(storeId)}`
        )
        expect(promoted.dispenseRequest?.performer?.identifier?.value).toBe('pharmacy-4821')
        expect(urlsOf(promoted.extension)).toEqual(extras)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should create a performer to hold the store link when no medication-processor supplied one', () => {
    // Arrange — the capture's `mr-0002` shape: store pair, no processor.
    const request = {
      ...MedicationRequest.empty,
      extension: storeExtensions(CarebookExtension.RequestExternalStoreId, '4821'),
      dispenseRequest: { ...emptyDispenseRequest },
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.dispenseRequest?.performer).toEqual({
      ...emptyReference,
      reference: 'https://www.rexall.ca/storelocator/store/4821',
    })
    expect(urlsOf(promoted.extension)).toEqual([])
  })

  it('should leave a lone half of the store pair untouched', () => {
    fc.assert(
      fc.property(fc.boolean(), storeIdArbitrary, (keepSource, storeId) => {
        // Arrange — only one of the two: not a store link, and never a silent drop.
        const [source, store] = storeExtensions(CarebookExtension.RequestExternalStoreId, storeId)
        const lone = keepSource ? source : store
        const request = {
          ...MedicationRequest.empty,
          extension: lone === undefined ? [] : [lone],
          dispenseRequest: { ...emptyDispenseRequest },
        }

        // Act
        const promoted = promoteMedicationRequest(request)

        // Assert
        expect(promoted.dispenseRequest?.performer).toBeNull()
        expect(promoted.extension).toEqual(request.extension)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never build a Rexall store link for another system source', () => {
    fc.assert(
      fc.property(
        fc.string().filter((source) => source !== REXALL_SYSTEM_SOURCE),
        storeIdArbitrary,
        (source, storeId) => {
          // Arrange
          const request = {
            ...MedicationRequest.empty,
            extension: [
              extensionWith(CarebookExtension.ExternalSystemSource, { valueString: source }),
              extensionWith(CarebookExtension.RequestExternalStoreId, { valueString: storeId }),
            ],
            dispenseRequest: { ...emptyDispenseRequest },
          }

          // Act
          const promoted = promoteMedicationRequest(request)

          // Assert
          expect(promoted.dispenseRequest?.performer).toBeNull()
          expect(promoted.extension).toEqual(request.extension)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should keep the store pair when there is no dispenseRequest to hold the link', () => {
    // Arrange
    const request = {
      ...MedicationRequest.empty,
      extension: storeExtensions(CarebookExtension.RequestExternalStoreId, '4821'),
      dispenseRequest: null,
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.extension).toEqual(request.extension)
  })
})

describe('promoteMedicationDispense', () => {
  it('should move medication-processor onto location', () => {
    // Arrange
    const dispense = {
      ...MedicationDispense.empty,
      extension: [
        extensionWith(CarebookExtension.DispenseMedicationProcessor, {
          valueReference: referenceTo('pharmacy-4821'),
        }),
      ],
    }

    // Act
    const promoted = promoteMedicationDispense(dispense)

    // Assert
    expect(promoted.location?.identifier?.value).toBe('pharmacy-4821')
    expect(urlsOf(promoted.extension)).toEqual([])
  })

  it('should mirror the store link on location.reference, keeping the pharmacy identifier', () => {
    fc.assert(
      fc.property(storeIdArbitrary, (storeId) => {
        // Arrange
        const dispense = {
          ...MedicationDispense.empty,
          extension: [
            extensionWith(CarebookExtension.DispenseMedicationProcessor, {
              valueReference: referenceTo('pharmacy-4821'),
            }),
            ...storeExtensions(CarebookExtension.DispenseExternalStoreId, storeId),
          ],
        }

        // Act
        const promoted = promoteMedicationDispense(dispense)

        // Assert
        expect(promoted.location?.reference).toBe(
          `https://www.rexall.ca/storelocator/store/${encodeURIComponent(storeId)}`
        )
        expect(promoted.location?.identifier?.value).toBe('pharmacy-4821')
        expect(urlsOf(promoted.extension)).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should leave a lone dispense external-store-id untouched', () => {
    // Arrange
    const dispense = {
      ...MedicationDispense.empty,
      extension: [
        extensionWith(CarebookExtension.DispenseExternalStoreId, { valueString: '4821' }),
      ],
    }

    // Act
    const promoted = promoteMedicationDispense(dispense)

    // Assert
    expect(promoted.location).toBeNull()
    expect(promoted.extension).toEqual(dispense.extension)
  })

  it('should leave the redundant medicationrecord-processor duplicate in place', () => {
    // Arrange — a deliberate keep: it is redundant, not misplaced, and dropping
    // redundant extensions is a separate decision from promoting misplaced ones.
    const dispense = {
      ...MedicationDispense.empty,
      extension: [
        extensionWith(CarebookExtension.DispenseMedicationProcessor, {
          valueReference: referenceTo('pharmacy-4821'),
        }),
        extensionWith(CarebookExtension.DispenseMedicationRecordProcessor, {
          valueReference: referenceTo('pharmacy-4821'),
        }),
      ],
    }

    // Act
    const promoted = promoteMedicationDispense(dispense)

    // Assert
    expect(urlsOf(promoted.extension)).toEqual([
      CarebookExtension.DispenseMedicationRecordProcessor,
    ])
  })
})

// Helpers

/** A non-blank store number, as `external-store-id` carries it. */
const storeIdArbitrary = fc.stringMatching(/^[A-Za-z0-9-]{0,6}[A-Za-z0-9]$/)
