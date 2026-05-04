import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Patient as StorePatient } from 'emr-core/livestore'

import * as Patient from './patient.ts'

const samplePatient: typeof StorePatient.RowSchema.Type = {
  resourceType: 'Patient',
  id: 'test-id',
  meta: {
    versionId: '',
    lastUpdated: null,
    source: '',
    security: [],
    tag: [],
  },
  implicitRules: new URL('http://a.aa/'),
  language: null,
  active: false,
  address: [],
  birthDate: null,
  communication: null,
  contact: null,
  deceasedBoolean: false,
  deceasedDateTime: null,
  gender: null,
  generalPractitioner: [],
  identifier: [],
  link: [],
  managingOrganization: null,
  maritalStatus: null,
  multipleBirthBoolean: false,
  multipleBirthInteger: null,
  name: [],
  photo: [],
  telecom: [],
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
}

describe('FhirR4Patient', () => {
  test('encode-decode round-trip with Some(meta) and empty collections', () => {
    const fhir = Schema.encodeSync(Patient.Schema)(samplePatient)
    const decoded = Schema.decodeSync(Patient.Schema)(fhir)
    expect(decoded).toSchemaEqual(StorePatient.RowSchema, samplePatient)
  })

  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StorePatient.RowSchema), (patient) => {
        const fhir = Schema.encodeSync(Patient.Schema)(patient)
        const decoded = Schema.decodeSync(Patient.Schema)(fhir)
        expect(decoded).toSchemaEqual(StorePatient.RowSchema, patient)
      })
    )
  })
})
