import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { AllDatatypeNames, DatatypeChoice } from '../schemas/index.ts'
import * as Patient from './patient.ts'

const PatientSchema = Patient.RowSchema

// `domain-resource.ts` annotates `contained`, `extension`, and `modifierExtension`
// with arbitraries that always produce empty arrays — a deliberate stand-in
// until those recursive shapes have proper generators. These tests pin that
// behavior and prove that round-tripping still works when callers supply
// non-empty values directly (i.e. outside the arbitrary path).
describe('DomainResource columns: contained / extension / modifierExtension', () => {
  test('default arbitraries always produce empty arrays', () => {
    fc.assert(
      fc.property(Arbitrary.make(PatientSchema), (patient) => {
        expect(patient.contained).toEqual([])
        expect(patient.extension).toEqual([])
        expect(patient.modifierExtension).toEqual([])
      })
    )
  })

  test('round-trips when contained / extension / modifierExtension are populated', () => {
    // Extension.Schema unions every FHIR R4 datatype as `value[x]`, so
    // building a wire-encoded Extension means filling every `value*` slot
    // with `null`. `DatatypeChoice(...).emptyEncoded` is the wire-shape with
    // every choice slot pre-set to `null`; spreading + overriding is the
    // canonical way to populate exactly one variant.
    const valueChoice = DatatypeChoice.DatatypeChoice('value', AllDatatypeNames)
    const stringExtensionEncoded = {
      id: null,
      extension: [],
      url: 'http://example.org/StructureDefinition/some-marker',
      ...valueChoice.emptyEncoded,
      valueString: 'marker-value',
    }
    const booleanExtensionEncoded = {
      id: null,
      extension: [],
      url: 'http://example.org/StructureDefinition/critical-flag',
      ...valueChoice.emptyEncoded,
      valueBoolean: true,
    }

    const encodedSeed: typeof PatientSchema.Encoded = {
      resourceType: 'Patient',
      id: 'pat-with-extensions',
      active: null,
      address: '[]',
      birthDate: null,
      communication: null,
      contact: null,
      deceasedBoolean: null,
      deceasedDateTime: null,
      gender: null,
      generalPractitioner: '[]',
      identifier: '[]',
      link: '[]',
      managingOrganization: null,
      maritalStatus: null,
      multipleBirthBoolean: null,
      multipleBirthInteger: null,
      name: '[]',
      photo: '[]',
      telecom: '[]',
      text: null,
      meta: null,
      implicitRules: null,
      language: null,
      // `contained` carries unmodelled inline resources (passthrough JSON).
      contained: JSON.stringify([{ resourceType: 'Observation', id: 'obs-1' }]),
      extension: JSON.stringify([stringExtensionEncoded]),
      modifierExtension: JSON.stringify([booleanExtensionEncoded]),
    }

    const decoded = Schema.decodeSync(PatientSchema)(encodedSeed)
    expect(decoded.contained).toHaveLength(1)
    expect(decoded.extension).toHaveLength(1)
    expect(decoded.extension[0]?.url).toBe('http://example.org/StructureDefinition/some-marker')
    expect(decoded.extension[0]?.valueString).toBe('marker-value')
    expect(decoded.modifierExtension).toHaveLength(1)
    expect(decoded.modifierExtension[0]?.url).toBe(
      'http://example.org/StructureDefinition/critical-flag'
    )
    expect(decoded.modifierExtension[0]?.valueBoolean).toBe(true)

    const reEncoded = Schema.encodeSync(PatientSchema)(decoded)
    const reDecoded = Schema.decodeSync(PatientSchema)(reEncoded)
    expect(reDecoded).toSchemaEqual(PatientSchema, decoded)
  })
})
