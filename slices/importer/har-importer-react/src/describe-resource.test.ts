import { describe, expect, it } from 'vite-plus/test'

import { describeResource } from './describe-resource.ts'

/**
 * `describeResource` is a pure per-type summariser: one example per FHIR type
 * pins the reviewer-facing summary line. The FHIR schemas here allow every
 * summary field to be absent, so each type also asserts the `resourceType/id`
 * fallback used when nothing survives — the summary must never be empty.
 */

describe('describeResource', () => {
  it('summarises a Patient by name and birthDate', () => {
    // Arrange
    const patient = {
      resourceType: 'Patient',
      id: 'pat-7',
      name: [{ given: ['Alice'], family: 'Jones' }],
      birthDate: '1990-01-01',
    }

    // Act
    const description = describeResource(patient)

    // Assert
    expect(description.type).toBe('Patient')
    expect(description.summary).toBe('Alice Jones · 1990-01-01')
  })

  it('summarises a MedicationRequest by medication and status', () => {
    // Arrange
    const request = {
      resourceType: 'MedicationRequest',
      id: 'mr-1',
      status: 'active',
      medicationCodeableConcept: { coding: [{ display: 'Aspirin 81 mg' }] },
    }

    // Act
    const description = describeResource(request)

    // Assert
    expect(description.type).toBe('MedicationRequest')
    expect(description.summary).toBe('Aspirin 81 mg · active')
  })

  it('summarises an Observation by code and value', () => {
    // Arrange
    const observation = {
      resourceType: 'Observation',
      id: 'obs-1',
      status: 'final',
      code: { text: 'Weight' },
      valueQuantity: { value: 70, unit: 'kg' },
    }

    // Act
    const description = describeResource(observation)

    // Assert
    expect(description.type).toBe('Observation')
    expect(description.summary).toBe('Weight · 70 kg')
  })

  it('falls back to resourceType/id when nothing summarisable is present', () => {
    // Arrange — a Patient with no name and no birthDate
    const bare = { resourceType: 'Patient', id: 'pat-3' }

    // Act
    const description = describeResource(bare)

    // Assert
    expect(description.summary).toBe('Patient/pat-3')
  })

  it('summarises a DocumentReference by its id', () => {
    // Arrange
    const document = { resourceType: 'DocumentReference', id: 'doc-1' }

    // Act / Assert
    expect(describeResource(document)).toEqual({
      type: 'DocumentReference',
      summary: 'DocumentReference/doc-1',
    })
  })
})
