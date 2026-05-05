import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { ChoiceElementSet, Datatype } from '../schemas/index.ts'
import * as Patient from './patient.ts'

const PatientSchema = Patient.RowSchema

// `domain-resource.ts` annotates `contained`, `extension`, and `modifierExtension`
// with arbitraries that always produce empty arrays — a deliberate stand-in
// until those recursive shapes have proper generators. These tests pin that
// behavior and prove that round-tripping still works when callers supply
// non-empty values directly (i.e. outside the arbitrary path).
describe('DomainResource columns: contained / extension / modifierExtension', () => {
  test('default arbitraries always produce empty arrays', () => {
    // Sample-based: the assertion is on the shape of the annotation, not on
    // arbitrary inputs. Property-testing this with `Arbitrary.make(PatientSchema)`
    // walked the full graph (Reference→Identifier, every column's nested
    // schemas) per iteration, blowing the 5s timeout.
    const samples = fc.sample(Arbitrary.make(PatientSchema), { numRuns: 5, seed: 1 })
    for (const patient of samples) {
      expect(patient.contained).toEqual([])
      expect(patient.extension).toEqual([])
      expect(patient.modifierExtension).toEqual([])
    }
  })

  test('round-trips when contained / extension / modifierExtension are populated', () => {
    const emptyValueChoice = ChoiceElementSet.empty('value', Datatype.names)

    const stringExtensionEncoded = {
      id: null,
      extension: [],
      url: 'http://example.org/StructureDefinition/some-marker',
      ...emptyValueChoice,
      valueString: 'marker-value',
    }
    const booleanExtensionEncoded = {
      id: null,
      extension: [],
      url: 'http://example.org/StructureDefinition/critical-flag',
      ...emptyValueChoice,
      valueBoolean: true,
    }

    const encodedSeed: typeof PatientSchema.Encoded = {
      resourceType: 'Patient',
      id: 'pat-with-extensions',
      active: null,
      address: '[]',
      birthDate: null,
      communication: '[]',
      contact: '[]',
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
