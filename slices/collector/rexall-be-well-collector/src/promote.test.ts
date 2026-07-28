import { Schema } from 'effect'
import * as fc from 'fast-check'
import { Code, Extension, type IdentifierAndReference } from 'fhir-r4/data-types'
import { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { CarebookCodingSystem, CarebookExtension } from './carebook.ts'
import { promoteMedicationDispense, promoteMedicationRequest } from './promote.ts'

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

  it('should link the orphaned contained Medication and retire the inline concept', () => {
    // Arrange
    const request = {
      ...MedicationRequest.empty,
      contained: [containedMedication({ id: 'med-1' })],
      medicationCodeableConcept: {
        id: null,
        extension: [],
        coding: [],
        text: 'Atorvastatin 20 mg tablet',
      },
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.medicationReference?.reference).toBe('#med-1')
    expect(promoted.medicationCodeableConcept).toBeNull()
  })

  it('should leave medication[x] alone when the contained Medication carries no code', () => {
    // Arrange — a Medication with no `code` cannot stand in for the inline concept.
    const request = {
      ...MedicationRequest.empty,
      contained: [{ resourceType: 'Medication', id: 'med-1' }],
      medicationCodeableConcept: { id: null, extension: [], coding: [], text: 'Something' },
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.medicationReference).toBeNull()
    expect(promoted.medicationCodeableConcept?.text).toBe('Something')
  })

  it('should promote a parseable strength to ingredient.strength and drop the extension', () => {
    // Arrange
    const request = {
      ...MedicationRequest.empty,
      contained: [containedMedication({ id: 'med-1', strength: '20 mg' })],
    }

    // Act
    const medication = firstContained(promoteMedicationRequest(request))

    // Assert
    // The Medication's own `code` becomes the ingredient item — R4 requires
    // `ingredient.item[x]`, and the strength is a strength *of* this drug.
    expect(medication['ingredient']).toEqual([
      {
        itemCodeableConcept: { text: 'Atorvastatin 20 mg tablet' },
        strength: ratioOf(20, 'mg'),
      },
    ])
    expect(containedExtensionUrls(medication)).toEqual([])
  })

  it('should keep an unparseable strength as an extension rather than dropping it', () => {
    // Arrange
    const request = {
      ...MedicationRequest.empty,
      contained: [containedMedication({ id: 'med-1', strength: 'as directed' })],
    }

    // Act
    const medication = firstContained(promoteMedicationRequest(request))

    // Assert
    expect(medication['ingredient']).toBeUndefined()
    expect(containedExtensionUrls(medication)).toEqual([CarebookExtension.MedicationStrength])
  })

  it('should move the Medication description into the resource narrative', () => {
    // Arrange
    const request = {
      ...MedicationRequest.empty,
      contained: [containedMedication({ id: 'med-1', description: '20 mg - Atorvastatin' })],
    }

    // Act
    const medication = firstContained(promoteMedicationRequest(request))

    // Assert
    expect(medication['text']).toEqual({ status: 'generated', div: '20 mg - Atorvastatin' })
    expect(containedExtensionUrls(medication)).toEqual([])
  })

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
            ...extras.map((url) => extensionWith(url, { valueString: 'kept' })),
          ],
          dispenseRequest: {
            ...emptyDispenseRequest,
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

// Helpers

/** Urls that cannot collide with a carebook one, so they must survive promotion. */
const unrelatedUrl = fc.string().map((suffix) => `http://example.org/${suffix}`)

const extensionWith = (url: string, value: Partial<Extension.Type>): Extension.Type => ({
  ...Extension.emptyValueChoice,
  id: null,
  extension: [],
  url,
  ...value,
})

const referenceTo = (id: string): IdentifierAndReference.ReferenceType => ({
  id: null,
  extension: [],
  display: null,
  type: null,
  reference: `rexall-pharmacy-location/${id}`,
  identifier: {
    id: null,
    extension: [],
    assigner: null,
    period: null,
    system: null,
    type: null,
    use: null,
    value: id,
  },
})

const emptyQuantity = {
  id: null,
  extension: [],
  code: null,
  comparator: null,
  system: null,
  unit: null,
  value: null,
}

const emptyDispenseRequest = {
  id: null,
  extension: [],
  modifierExtension: [],
  initialFill: null,
  dispenseInterval: null,
  validityPeriod: null,
  numberOfRepeatsAllowed: null,
  quantity: null,
  expectedSupplyDuration: null,
  performer: null,
}

/** A `contained` Medication in its raw wire shape, as the dialect sends it. */
const containedMedication = (options: {
  readonly id: string
  readonly strength?: string
  readonly description?: string
}): Record<string, unknown> => ({
  resourceType: 'Medication',
  id: options.id,
  code: { text: 'Atorvastatin 20 mg tablet' },
  extension: [
    ...(options.strength === undefined
      ? []
      : [{ url: CarebookExtension.MedicationStrength, valueString: options.strength }]),
    ...(options.description === undefined
      ? []
      : [{ url: CarebookExtension.MedicationDescription, valueString: options.description }]),
  ],
})

const ratioOf = (
  value: number,
  unit: string
): { readonly numerator: unknown; readonly denominator: unknown } => ({
  numerator: { value, unit },
  denominator: { value: 1 },
})

const urlsOf = (extensions: readonly Extension.Type[]): readonly string[] =>
  extensions.map((extension) => extension.url)

const decodeRecord = Schema.decodeUnknownSync(
  Schema.Record({ key: Schema.String, value: Schema.Unknown })
)

const firstContained = (resource: {
  readonly contained: readonly unknown[]
}): Record<string, unknown> => decodeRecord(resource.contained[0])

const containedExtensionUrls = (medication: Record<string, unknown>): readonly string[] => {
  const extensions = medication['extension']
  return Array.isArray(extensions)
    ? extensions.map((extension: { readonly url?: string }) => extension.url ?? '')
    : []
}
