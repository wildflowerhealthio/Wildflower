import { cleanup, render, screen } from '@testing-library/react'
import { Schema } from 'effect'
import type { PatientResource } from 'fhir-r4-react'
import { Patient } from 'fhir-r4/resources'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { PatientDetails } from './patient-details.tsx'
import type * as PebbleSettings from './pebble-settings.ts'

// Which name is shown is `patientName`'s rule, tested in `patient-name.test.ts`.

afterEach(() => {
  cleanup()
})

describe('PatientDetails', () => {
  it('should show the patient the watch will sync to, and on which server', () => {
    // Act
    render(
      <PatientDetails
        patient={patient({
          name: [{ given: ['Ada'], family: 'Lovelace' }],
          birthDate: '1815-12-10',
        })}
        connection={connection}
      />
    )

    // Assert
    expect(screen.getByText('Ada Lovelace')).toBeDefined()
    expect(screen.getByText('1815-12-10')).toBeDefined()
    expect(screen.getByText('ada')).toBeDefined()
    expect(screen.getByText('https://fhir.example/r4')).toBeDefined()
  })

  it('should say so when the patient has no name on record', () => {
    // Act
    render(<PatientDetails patient={patient({})} connection={connection} />)

    // Assert
    expect(screen.getByText('No name on record')).toBeDefined()
  })

  it('should leave out the birth date when the record has none', () => {
    // Act
    render(
      <PatientDetails patient={patient({ name: [{ text: 'Ada' }] })} connection={connection} />
    )

    // Assert
    expect(screen.queryByText('Birth date')).toBeNull()
  })
})

// Helpers

const connection: PebbleSettings.Connection = {
  patientId: 'ada',
  accessToken: 'watch-token',
  fhirBaseUrl: 'https://fhir.example/r4',
}

/** A decoded `Patient` with id `ada` and the given fields. */
const patient = (fields: Readonly<Record<string, unknown>>): PatientResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id: 'ada', ...fields })
