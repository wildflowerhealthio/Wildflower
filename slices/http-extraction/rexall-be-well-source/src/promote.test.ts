import { Schema } from 'effect'
import * as fc from 'fast-check'
import {
  CanadianCodingSystem,
  Code,
  CodeableConcept,
  Extension,
  IdentifierAndReference,
  WildflowerExtension,
} from 'fhir-r4/data-types'
import { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { CarebookCodingSystem, CarebookExtension, REXALL_SYSTEM_SOURCE } from './carebook.ts'
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

    // Assert — the concept's label survives on the reference, so a reader that
    // renders `medication[x]` still has a name after the choice slot moves.
    expect(promoted.medicationReference?.reference).toBe('#med-1')
    expect(promoted.medicationReference?.display).toBe('Atorvastatin 20 mg tablet')
    expect(promoted.medicationCodeableConcept).toBeNull()
  })

  it('should keep an existing medicationReference display when it relinks', () => {
    // Arrange — the pre-promotion carebook shape: a `#` reference that already
    // names the drug. Retargeting it must not cost the name.
    const request = {
      ...MedicationRequest.empty,
      contained: [containedMedication({ id: 'med-1' })],
      medicationReference: {
        ...emptyReference,
        reference: '#med-0',
        display: 'Atorvastatin 20 mg tablet',
      },
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.medicationReference?.reference).toBe('#med-1')
    expect(promoted.medicationReference?.display).toBe('Atorvastatin 20 mg tablet')
  })

  it('should take the display from the contained code when nothing else names the drug', () => {
    // Arrange — the real capture's DIN codings carry `{system, code}` only, so
    // a contained Medication may have no `text` and no coding `display`.
    const request = {
      ...MedicationRequest.empty,
      contained: [
        {
          resourceType: 'Medication',
          id: 'med-1',
          code: { coding: [{ system: 'urn:din', code: '02241497', display: 'Atorvastatin' }] },
        },
      ],
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.medicationReference?.display).toBe('Atorvastatin')
  })

  it('should never retarget a medicationReference that points outside the resource', () => {
    // Arrange — an external Medication is somebody else's resource; the
    // contained one is an addition, not a correction.
    const request = {
      ...MedicationRequest.empty,
      contained: [containedMedication({ id: 'med-1' })],
      medicationReference: { ...emptyReference, reference: 'Medication/external-1' },
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.medicationReference?.reference).toBe('Medication/external-1')
  })

  it('should leave medication[x] alone when the contained Medication has an explicit null code', () => {
    // Arrange — `contained` is raw passthrough JSON, so an explicit `null` is
    // never filtered out upstream. It is as unusable as an absent code.
    const request = {
      ...MedicationRequest.empty,
      contained: [{ resourceType: 'Medication', id: 'med-1', code: null }],
      medicationCodeableConcept: { id: null, extension: [], coding: [], text: 'Something' },
    }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.medicationReference).toBeNull()
    expect(promoted.medicationCodeableConcept?.text).toBe('Something')
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

  it('should never read a thousands separator as a decimal point', () => {
    // Arrange — Rexall is an English-Canadian pharmacy: `1,000 mg` is one
    // thousand milligrams. Parsing the comma as a decimal point would write a
    // 1 mg strength and drop the extension that held the truth.
    const request = {
      ...MedicationRequest.empty,
      contained: [containedMedication({ id: 'med-1', strength: '1,000 mg' })],
    }

    // Act
    const medication = firstContained(promoteMedicationRequest(request))

    // Assert
    expect(medication['ingredient']).toBeUndefined()
    expect(containedExtensionUrls(medication)).toEqual([CarebookExtension.MedicationStrength])
  })

  it('should merge the strength into the first ingredient without dropping the others', () => {
    // Arrange — a compounded prescription. Replacing `ingredient` outright
    // would delete both real ingredients.
    const request = {
      ...MedicationRequest.empty,
      contained: [
        {
          ...containedMedication({ id: 'med-1', strength: '20 mg' }),
          ingredient: [
            { itemCodeableConcept: { text: 'Ingredient A' }, isActive: true },
            { itemCodeableConcept: { text: 'Ingredient B' } },
          ],
        },
      ],
    }

    // Act
    const medication = firstContained(promoteMedicationRequest(request))

    // Assert
    expect(medication['ingredient']).toEqual([
      {
        itemCodeableConcept: { text: 'Ingredient A' },
        isActive: true,
        strength: ratioOf(20, 'mg'),
      },
      { itemCodeableConcept: { text: 'Ingredient B' } },
    ])
  })

  it('should move the Medication description into a conformant XHTML narrative', () => {
    // Arrange
    const request = {
      ...MedicationRequest.empty,
      contained: [containedMedication({ id: 'med-1', description: '20 mg - Atorvastatin' })],
    }

    // Act
    const medication = firstContained(promoteMedicationRequest(request))

    // Assert — R4 types `Narrative.div` as `xhtml`; a bare string is not a
    // legal narrative, and a conformant server rejects it on write.
    expect(medication['text']).toEqual({
      status: 'generated',
      div: '<div xmlns="http://www.w3.org/1999/xhtml">20 mg - Atorvastatin</div>',
    })
    expect(containedExtensionUrls(medication)).toEqual([])
  })

  it('should escape a description that would otherwise break the narrative markup', () => {
    // Arrange
    const request = {
      ...MedicationRequest.empty,
      contained: [containedMedication({ id: 'med-1', description: '5 mg & 10 mg <combo>' })],
    }

    // Act
    const medication = firstContained(promoteMedicationRequest(request))

    // Assert
    expect(medication['text']).toEqual({
      status: 'generated',
      div: '<div xmlns="http://www.w3.org/1999/xhtml">5 mg &amp; 10 mg &lt;combo&gt;</div>',
    })
  })

  it('should replace the dialect narrative, which is a byte-copy of code.text', () => {
    // Arrange — what the real capture sends. The copy is why the narrative is
    // free real estate: the description is strictly richer than the same string.
    const request = {
      ...MedicationRequest.empty,
      contained: [
        {
          ...containedMedication({ id: 'med-1', description: '20 mg - Atorvastatin' }),
          text: { status: 'generated', div: 'Atorvastatin 20 mg tablet' },
        },
      ],
    }

    // Act
    const medication = firstContained(promoteMedicationRequest(request))

    // Assert
    expect(medication['text']).toEqual({
      status: 'generated',
      div: '<div xmlns="http://www.w3.org/1999/xhtml">20 mg - Atorvastatin</div>',
    })
  })

  it('should not overwrite a narrative holding something other than the code text', () => {
    // Arrange — somebody's real content. The promotion stands down, and per the
    // lift-and-drop rule the description extension stays where it is.
    const request = {
      ...MedicationRequest.empty,
      contained: [
        {
          ...containedMedication({ id: 'med-1', description: '20 mg - Atorvastatin' }),
          text: { status: 'additional', div: '<div>Do not crush. Take with food.</div>' },
        },
      ],
    }

    // Act
    const medication = firstContained(promoteMedicationRequest(request))

    // Assert
    expect(medication['text']).toEqual({
      status: 'additional',
      div: '<div>Do not crush. Take with food.</div>',
    })
    expect(containedExtensionUrls(medication)).toEqual([CarebookExtension.MedicationDescription])
  })

  it('should promote the siblings of a malformed extension entry', () => {
    // Arrange — one entry with no `url`. Decoding the array as a whole would
    // silently switch off every promotion on this Medication.
    const request = {
      ...MedicationRequest.empty,
      contained: [
        {
          resourceType: 'Medication',
          id: 'med-1',
          code: { text: 'Atorvastatin 20 mg tablet' },
          extension: [
            { valueString: 'no url here' },
            { url: CarebookExtension.MedicationDescription, valueString: '20 mg - Atorvastatin' },
          ],
        },
      ],
    }

    // Act
    const medication = firstContained(promoteMedicationRequest(request))

    // Assert
    expect(medication['text']).toEqual({
      status: 'generated',
      div: '<div xmlns="http://www.w3.org/1999/xhtml">20 mg - Atorvastatin</div>',
    })
    expect(medication['extension']).toEqual([{ valueString: 'no url here' }])
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

  it('should give a contained vendor DIN coding exactly one canonical twin with the same code', () => {
    fc.assert(
      fc.property(dinArbitrary, fc.boolean(), (din, twice) => {
        // Arrange
        const request = {
          ...MedicationRequest.empty,
          contained: [{ ...containedMedication({ id: 'med-1' }), code: vendorDinCode(din) }],
        }

        // Act — a second pass must not add a second canonical coding.
        const once = promoteMedicationRequest(request)
        const promoted = twice ? promoteMedicationRequest(once) : once

        // Assert — additive: the vendor coding is still there, first.
        expect(rawCodingSystemsFor(firstContained(promoted), din)).toEqual([
          CarebookCodingSystem.Din,
          CanadianCodingSystem.Din,
        ])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should give an inline medicationCodeableConcept vendor DIN its canonical twin', () => {
    fc.assert(
      fc.property(dinArbitrary, (din) => {
        // Arrange — no contained Medication, so the inline concept stays put.
        const request = {
          ...MedicationRequest.empty,
          medicationCodeableConcept: decodedVendorDinConcept(din),
        }

        // Act
        const promoted = promoteMedicationRequest(request)

        // Assert
        expect(decodedCodingSystemsFor(promoted.medicationCodeableConcept, din)).toEqual([
          CarebookCodingSystem.Din,
          CanadianCodingSystem.Din,
        ])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
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

  it('should return a contained entry that is not a Medication exactly as it went in', () => {
    fc.assert(
      fc.property(nonMedicationEntry, (entry) => {
        // Arrange
        const request = { ...MedicationRequest.empty, contained: [entry] }

        // Act
        const promoted = promoteMedicationRequest(request)

        // Assert
        expect(promoted.contained[0]).toBe(entry)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should leave a contained Medication whose shape does not decode untouched', () => {
    // Arrange — `contained` is raw passthrough, so a malformed `code` (here a
    // bare string) reaches promotion. It is not a concept to hang a strength
    // or a link on, so nothing on the entry moves.
    const entry = {
      ...containedMedication({ id: 'med-1', strength: '20 mg', description: 'Drug' }),
      code: 'Atorvastatin 20 mg tablet',
    }
    const request = { ...MedicationRequest.empty, contained: [entry] }

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.contained[0]).toBe(entry)
    expect(promoted.medicationReference).toBeNull()
  })

  it('should carry every key it does not read through a promoted contained Medication', () => {
    fc.assert(
      fc.property(unreadContainedFields, (extras) => {
        // Arrange
        const request = {
          ...MedicationRequest.empty,
          contained: [{ ...extras, ...containedMedication({ id: 'med-1', strength: '20 mg' }) }],
        }

        // Act
        const medication = firstContained(promoteMedicationRequest(request))

        // Assert
        expect(medication).toMatchObject(extras)
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

  it('should give the dispense medicationCodeableConcept vendor DIN its canonical twin', () => {
    fc.assert(
      fc.property(dinArbitrary, (din) => {
        // Arrange
        const dispense = {
          ...MedicationDispense.empty,
          medicationCodeableConcept: decodedVendorDinConcept(din),
        }

        // Act
        const promoted = promoteMedicationDispense(dispense)

        // Assert
        expect(decodedCodingSystemsFor(promoted.medicationCodeableConcept, din)).toEqual([
          CarebookCodingSystem.Din,
          CanadianCodingSystem.Din,
        ])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
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

  it('should promote a contained Medication exactly as the request path does', () => {
    // Arrange — no dispense in the reference capture inlines a Medication, but
    // it has the same raw `contained` slot. One that did would otherwise land
    // in the store shaped differently from the identical drug on the request
    // beside it.
    const dispense = {
      ...MedicationDispense.empty,
      contained: [
        containedMedication({
          id: 'med-1',
          strength: '20 mg',
          description: '20 mg - Atorvastatin',
        }),
      ],
    }

    // Act
    const medication = firstContained(promoteMedicationDispense(dispense))

    // Assert
    expect(medication['text']).toEqual({
      status: 'generated',
      div: '<div xmlns="http://www.w3.org/1999/xhtml">20 mg - Atorvastatin</div>',
    })
    expect(medication['ingredient']).toEqual([
      { itemCodeableConcept: { text: 'Atorvastatin 20 mg tablet' }, strength: ratioOf(20, 'mg') },
    ])
    expect(containedExtensionUrls(medication)).toEqual([])
  })

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

// Helpers

/** Urls that cannot collide with a carebook one, so they must survive promotion. */
const unrelatedUrl = fc.string().map((suffix) => `http://example.org/${suffix}`)

/** A raw `contained` entry of any resource type but `Medication`. */
const nonMedicationEntry = fc
  .tuple(
    fc.string().filter((resourceType) => resourceType !== 'Medication'),
    fc.dictionary(fc.string(), fc.jsonValue())
  )
  .map(([resourceType, fields]) => ({ ...fields, resourceType }))

/** Keys a contained Medication's promotion never reads, with arbitrary JSON values. */
const unreadContainedFields = fc.dictionary(
  fc
    .string({ minLength: 1 })
    .filter(
      (key) =>
        key !== '__proto__' &&
        !['resourceType', 'id', 'code', 'text', 'extension', 'ingredient'].includes(key)
    ),
  fc.jsonValue()
)

/** An 8-digit Health Canada DIN. */
const dinArbitrary = fc.stringMatching(/^\d{8}$/)

/** A non-blank store number, as `external-store-id` carries it. */
const storeIdArbitrary = fc.stringMatching(/^[A-Za-z0-9-]{0,6}[A-Za-z0-9]$/)

/** The `external-system-source` (Rexall) + `external-store-id` pair, in that order. */
const storeExtensions = (storeIdUrl: string, storeId: string): readonly Extension.Type[] => [
  extensionWith(CarebookExtension.ExternalSystemSource, { valueString: REXALL_SYSTEM_SOURCE }),
  extensionWith(storeIdUrl, { valueString: storeId }),
]

/** The dialect's dual-written remaining-repeats `modifierExtension`s, either copy optional. */
const repeatsModifiers = (copies: {
  readonly v1?: number
  readonly v2?: number
}): readonly Extension.Type[] => [
  ...(copies.v1 === undefined
    ? []
    : [
        extensionWith(CarebookExtension.NumberOfRepeatsAvailable, {
          valuePositiveInt: copies.v1,
        }),
      ]),
  ...(copies.v2 === undefined
    ? []
    : [extensionWith(CarebookExtension.NumberOfRepeatsAvailableV2, { valueDecimal: copies.v2 })]),
]

/** A raw `contained` Medication `code` carrying one carebook vendor DIN coding. */
const vendorDinCode = (din: string): Record<string, unknown> => ({
  coding: [{ system: CarebookCodingSystem.Din, code: din }],
  text: 'Atorvastatin 20 mg tablet',
})

/** A decoded `CodeableConcept` carrying one carebook vendor DIN coding. */
const decodedVendorDinConcept = (din: string): typeof CodeableConcept.Schema.Type => ({
  id: null,
  extension: [],
  text: 'Atorvastatin 20 mg tablet',
  coding: [
    {
      id: null,
      extension: [],
      code: Code.make(din),
      display: null,
      system: new URL(CarebookCodingSystem.Din),
      userSelected: null,
      version: null,
    },
  ],
})

const decodeConcept = Schema.decodeUnknownSync(Schema.typeSchema(CodeableConcept.Schema))

/** The `system` href of every decoded `coding` whose `code` is `din`, in order. */
const decodedCodingSystemsFor = (concept: unknown, din: string): readonly (string | undefined)[] =>
  decodeConcept(concept)
    .coding.filter((coding) => coding.code === din)
    .map((coding) => coding.system?.href)

/** The `system` of every raw `code.coding` on a contained Medication whose `code` is `din`. */
const rawCodingSystemsFor = (
  medication: Record<string, unknown>,
  din: string
): readonly unknown[] => {
  const code = decodeRecord(medication['code'])
  const codings = code['coding']
  return Array.isArray(codings)
    ? codings
        .map((coding: unknown) => decodeRecord(coding))
        .filter((coding) => coding['code'] === din)
        .map((coding) => coding['system'])
    : []
}

const extensionWith = (url: string, value: Partial<Extension.Type>): Extension.Type => ({
  ...Extension.emptyValueChoice,
  id: null,
  extension: [],
  url,
  ...value,
})

const emptyReference = IdentifierAndReference.emptyReference

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
