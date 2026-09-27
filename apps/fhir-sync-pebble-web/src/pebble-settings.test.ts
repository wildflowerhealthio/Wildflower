import { Either, Schema } from 'effect'
import * as fc from 'fast-check'
import type { PatientResource } from 'fhir-r4-react'
import { Patient } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as PebbleSettings from './pebble-settings.ts'

describe('fromGrant', () => {
  it('should carry the patient, token and server a complete grant names', () => {
    // Arrange
    const grant: PebbleSettings.Grant = {
      patientId: 'ada',
      accessToken: 'watch-token',
      fhirBaseUrl: 'https://fhir.example/r4',
    }

    // Act
    const connection = PebbleSettings.fromGrant(grant)

    // Assert
    expect(connection).toStrictEqual(Either.right(grant))
  })

  it('should refuse a grant whose server put no patient in context', () => {
    // Act
    const connection = PebbleSettings.fromGrant({
      patientId: null,
      accessToken: 'watch-token',
      fhirBaseUrl: 'https://fhir.example/r4',
    })

    // Assert
    expect(connection).toStrictEqual(Either.left(new PebbleSettings.MissingGrantError()))
  })

  it('should refuse a grant that came with no access token', () => {
    // Act
    const connection = PebbleSettings.fromGrant({
      patientId: 'ada',
      accessToken: undefined,
      fhirBaseUrl: 'https://fhir.example/r4',
    })

    // Assert
    expect(connection).toStrictEqual(Either.left(new PebbleSettings.MissingGrantError()))
  })
})

describe('withPatient', () => {
  it("should name the patient for the watch's on-device confirmation", () => {
    // Act
    const settings = PebbleSettings.withPatient(
      connection,
      patient({ name: [{ given: ['Ada'], family: 'Lovelace' }], birthDate: '1815-12-10' })
    )

    // Assert
    expect(settings).toStrictEqual({
      patientId: 'ada',
      patientName: 'Ada Lovelace',
      patientBirthDate: '1815-12-10',
      accessToken: 'watch-token',
      fhirBaseUrl: 'https://fhir.example/r4',
    })
  })

  it('should send null for a name or birth date the record does not have', () => {
    // Act
    const settings = PebbleSettings.withPatient(connection, patient({}))

    // Assert
    expect(settings.patientName).toBeNull()
    expect(settings.patientBirthDate).toBeNull()
  })

  it('should always keep the connection the grant carried', () => {
    fc.assert(
      fc.property(connectionArb, (granted) => {
        // Act
        const settings = PebbleSettings.withPatient(granted, patient({}))

        // Assert
        expect({
          patientId: settings.patientId,
          accessToken: settings.accessToken,
          fhirBaseUrl: settings.fhirBaseUrl,
        }).toStrictEqual(granted)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('toJson', () => {
  it('should write the five flat fields the watchapp reads, null when absent', () => {
    // Act
    const json = PebbleSettings.toJson({
      patientId: 'ada',
      patientName: 'Ada Lovelace',
      patientBirthDate: null,
      accessToken: 'watch-token',
      fhirBaseUrl: 'https://fhir.example/r4',
    })

    // Assert
    expect(json).toBe(
      '{"patientId":"ada","patientName":"Ada Lovelace","patientBirthDate":null,' +
        '"accessToken":"watch-token","fhirBaseUrl":"https://fhir.example/r4"}'
    )
  })

  it('should always parse back to the settings it was given', () => {
    fc.assert(
      fc.property(settingsArb, (settings) => {
        // Act
        const json = PebbleSettings.toJson(settings)

        // Assert
        expect(JSON.parse(json)).toStrictEqual(settings)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const connection: PebbleSettings.Connection = {
  patientId: 'ada',
  accessToken: 'watch-token',
  fhirBaseUrl: 'https://fhir.example/r4',
}

const connectionArb: fc.Arbitrary<PebbleSettings.Connection> = fc.record({
  patientId: fc.string({ minLength: 1 }),
  accessToken: fc.string({ minLength: 1 }),
  fhirBaseUrl: fc.webUrl(),
})

const settingsArb: fc.Arbitrary<PebbleSettings.Type> = fc.record({
  patientId: fc.string({ minLength: 1 }),
  patientName: fc.option(fc.string(), { nil: null }),
  patientBirthDate: fc.option(fc.string(), { nil: null }),
  accessToken: fc.string({ minLength: 1 }),
  fhirBaseUrl: fc.webUrl(),
})

/** A decoded `Patient` with id `ada` and the given fields. */
const patient = (fields: Readonly<Record<string, unknown>>): PatientResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id: 'ada', ...fields })
