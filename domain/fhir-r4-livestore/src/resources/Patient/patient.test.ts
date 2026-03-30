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
