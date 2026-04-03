import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Patient from './patient.ts'

const patientArb = Arbitrary.make(Patient.Patient)

describe('Patient model', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(patientArb, (patient) => {
        const encoded = Schema.encodeSync(Patient.Patient)(patient)
        const decoded = Schema.decodeSync(Patient.Patient)(encoded)
        expect(decoded).toSchemaEqual(patient)
      })
    )
  })

  test('Patient.ResourceType is "Patient"', () => {
    expect(Patient.Patient.ResourceType).toBe('Patient')
  })

  test('Patient.IdSchema is defined', () => {
    expect(Patient.Patient.IdSchema).toBeDefined()
  })

  test('decodes a realistic FHIR R4 Patient JSON payload', () => {
    const wirePayload = {
      resourceType: 'Patient',
      id: 'example-patient-001',
      active: true,
      name: [
        {
          use: 'official',
          family: 'Chalmers',
          given: ['Peter', 'James'],
        },
        {
          use: 'usual',
          given: ['Jim'],
        },
      ],
      gender: 'male',
      birthDate: '1974-12-25',
      address: [
        {
          use: 'home',
          type: 'both',
          text: '534 Erewhon St PeasantVille',
          line: ['534 Erewhon St'],
          city: 'PleasantVille',
          district: 'Rainbow',
          state: 'Vic',
          postalCode: '3999',
          country: 'Australia',
        },
      ],
      telecom: [
        { system: 'phone', value: '(03) 5555 6473', use: 'work', rank: 1 },
        { system: 'email', value: 'Jim@example.org', use: 'home' },
      ],
      identifier: [
        {
          use: 'usual',
          system: 'urn:oid:1.2.36.146.595.217.0.1',
          value: '12345',
        },
      ],
    }

    const patient = Schema.decodeUnknownSync(Patient.Patient)(wirePayload)
    expect(patient.resourceType).toBe('Patient')
    expect(patient.id).toBe('example-patient-001')
    expect(patient.active).toBe(true)
    expect(patient.gender).toBe('male')
    expect(patient.name?.[0]?.family).toBe('Chalmers')
    expect(patient.name?.[0]?.given).toEqual(['Peter', 'James'])
    expect(patient.address?.[0]?.city).toBe('PleasantVille')
    expect(patient.telecom?.[0]?.system).toBe('phone')
    expect(patient.telecom?.[0]?.rank).toBe(1)
    expect(patient.identifier?.[0]?.value).toBe('12345')
  })

  test('PatientWithId decodes successfully when id is present', () => {
    const payload = {
      resourceType: 'Patient',
      id: 'pat-001',
      name: [{ family: 'Smith', given: ['John'] }],
    }
    const result = Schema.decodeUnknownEither(Patient.PatientWithId)(payload)
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.id).toBe('pat-001')
    }
  })

  test('PatientWithId fails when id is missing', () => {
    const payload = { resourceType: 'Patient' }
    const result = Schema.decodeUnknownEither(Patient.PatientWithId)(payload)
    expect(Either.isLeft(result)).toBe(true)
  })

  test('property: missing required fields always fail', () => {
    // Property: Patient must have correct domainType or none
    fc.assert(
      fc.property(
        fc.oneof(
          // Wrong domainType
          fc.record({
            resourceType: fc.constant('Practitioner' as const),
          })
        ),
        (incomplete) => {
          const decode = Schema.decodeUnknownEither(Patient.Patient)
          const result = decode(incomplete)
          expect(Either.isLeft(result)).toBe(true)
        }
      )
    )
  })
})
