import * as fc from 'fast-check'
import { WildflowerExtension } from 'fhir-r4/data-types'
import { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { CarebookExtension } from '../carebook.ts'
import { promoteMedicationDispense } from './medication-dispense.ts'
import { promoteMedicationRequest } from './medication-request.ts'
import {
  containedExtensionUrls,
  containedMedication,
  emptyReference,
  firstContained,
} from './test-helpers.ts'

describe('promoteMedicationRequest', () => {
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

  it('should keep a narrative holding other content and move the description to the Wildflower extension', () => {
    // Arrange — somebody's real content, which the description must not
    // overwrite. The description still leaves the vendor url, so a reader
    // finds it without knowing carebook's.
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
    expect(medication['extension']).toEqual([
      { url: WildflowerExtension.MedicationDescription, valueString: '20 mg - Atorvastatin' },
    ])
  })

  it('should name the drug as the item of an ingredient whose item is an explicit null', () => {
    // Arrange — `null` names nothing, so the strength would otherwise be a
    // strength of no item, which R4 does not allow.
    const request = {
      ...MedicationRequest.empty,
      contained: [
        {
          ...containedMedication({ id: 'med-1', strength: '20 mg' }),
          ingredient: [{ itemCodeableConcept: null }],
        },
      ],
    }

    // Act
    const medication = firstContained(promoteMedicationRequest(request))

    // Assert
    expect(medication['ingredient']).toEqual([
      {
        itemCodeableConcept: { text: 'Atorvastatin 20 mg tablet' },
        strength: ratioOf(20, 'mg'),
      },
    ])
  })

  it('should drop an explicit null it reads from a contained Medication it promotes', () => {
    // Arrange — FHIR JSON has no `null` values, so the absence is written back
    // as a missing key.
    const request = {
      ...MedicationRequest.empty,
      contained: [
        {
          ...containedMedication({ id: 'med-1', strength: '20 mg' }),
          ingredient: [{ itemCodeableConcept: { text: 'Atorvastatin' }, itemReference: null }],
        },
      ],
    }

    // Act
    const medication = firstContained(promoteMedicationRequest(request))

    // Assert
    expect(medication['ingredient']).toStrictEqual([
      { itemCodeableConcept: { text: 'Atorvastatin' }, strength: ratioOf(20, 'mg') },
    ])
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
})

describe('promoteMedicationDispense', () => {
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
})

// Helpers

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

const ratioOf = (
  value: number,
  unit: string
): { readonly numerator: unknown; readonly denominator: unknown } => ({
  numerator: { value, unit },
  denominator: { value: 1 },
})
