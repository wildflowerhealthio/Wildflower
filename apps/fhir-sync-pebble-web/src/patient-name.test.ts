import { Schema } from 'effect'
import * as fc from 'fast-check'
import type { PatientResource } from 'fhir-r4-react'
import { Patient } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { patientName } from './patient-name.ts'

describe('patientName', () => {
  it('should join the given names and the family name', () => {
    expect(patientName(patient([{ given: ['Ada', 'Augusta'], family: 'Lovelace' }]))).toBe(
      'Ada Augusta Lovelace'
    )
  })

  it('should fall back to the name text when the name has no parts', () => {
    expect(patientName(patient([{ text: 'Ada King' }]))).toBe('Ada King')
  })

  it('should skip a blank name for the next one on record', () => {
    expect(patientName(patient([{ given: [' '] }, { given: ['Ada'], family: 'Lovelace' }]))).toBe(
      'Ada Lovelace'
    )
  })

  it('should be null when the record has no name', () => {
    expect(patientName(patient([]))).toBeNull()
  })

  it('should never return a blank name', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record(
            { given: fc.array(fc.string()), family: fc.string(), text: fc.string() },
            { requiredKeys: [] }
          )
        ),
        (names) => {
          // Act
          const name = patientName(patient(names))

          // Assert
          expect(name === null || name.trim().length > 0).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** A decoded `Patient` carrying `names`. */
const patient = (names: readonly unknown[]): PatientResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id: 'ada', name: names })
