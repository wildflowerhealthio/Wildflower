import { MedicationRequest } from 'fhir-r4/resources'
import { describe, expect, it } from 'vite-plus/test'

import { CarebookExtension } from '../carebook.ts'
import { promoteMedicationRequest } from './medication-request.ts'
import { containedExtensionUrls, containedMedication, firstContained } from './test-helpers.ts'

describe('promoteMedicationRequest', () => {
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
})
