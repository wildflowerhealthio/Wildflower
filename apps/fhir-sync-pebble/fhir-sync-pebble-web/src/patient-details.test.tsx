import { cleanup, render, screen } from '@testing-library/react'
import { Schema } from 'effect'
import { PatientSummary, type PebbleSettings } from 'fhir-sync-pebble-core-js'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { PatientDetails } from './patient-details.tsx'

// Which name is shown is `fhir-r4`'s `HumanName.displayName` rule, tested there.

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
  accessToken: 'watch-token',
  fhirBaseUrl: 'https://fhir.example/r4',
}

/** The patient `ada` as the settings page lists it, with the given fields. */
const patient = (fields: Readonly<Record<string, unknown>>): PatientSummary.Type =>
  Schema.decodeUnknownSync(PatientSummary.Schema)({ resourceType: 'Patient', id: 'ada', ...fields })
