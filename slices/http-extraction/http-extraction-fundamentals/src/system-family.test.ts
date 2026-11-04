import { describe, expect, test } from 'vite-plus/test'

import * as SystemFamily from './system-family.ts'

/**
 * Covers which system each family gives a type, and which reference literals
 * each relativises: the FHIR style appends the type to the base URL and reads
 * the server's absolute spelling of its own record back to the relative one;
 * a fixed system is the same whatever the type and relativises nothing; a
 * per-type family gives each type the system it lists, refuses a type it does
 * not list, and relativises nothing.
 */

const BASE_URL = 'https://source.example/baseR4'
const SYSTEM = 'https://wildflowerhealth.io/fhir/sid/example-portal'

const FHIR_STYLE = SystemFamily.FhirStyleBaseUrl({ baseUrl: BASE_URL })
const FIXED = SystemFamily.FixedAcrossResourceTypes({ system: SYSTEM })
const PATIENT_ID_SYSTEM = 'https://portal.example/fhir/identifier/patient-id'
const DISPENSE_ID_SYSTEM = 'https://portal.example/fhir/identifier/dispense-id'
const PER_TYPE = SystemFamily.SystemPerResourceType({
  systems: { Patient: PATIENT_ID_SYSTEM, MedicationDispense: DISPENSE_ID_SYSTEM },
})

describe('SystemFamily.systemFor', () => {
  test('the FHIR style appends the type to the base URL', () => {
    expect(SystemFamily.systemFor(FHIR_STYLE, 'Patient')).toBe(`${BASE_URL}/Patient`)
    expect(SystemFamily.systemFor(FHIR_STYLE, 'Observation')).toBe(`${BASE_URL}/Observation`)
  })

  test('a fixed system is the same whatever the type', () => {
    expect(SystemFamily.systemFor(FIXED, 'Patient')).toBe(SYSTEM)
    expect(SystemFamily.systemFor(FIXED, 'Observation')).toBe(SYSTEM)
  })

  test('a per-type family gives each type the system it lists for it', () => {
    expect(SystemFamily.systemFor(PER_TYPE, 'Patient')).toBe(PATIENT_ID_SYSTEM)
    expect(SystemFamily.systemFor(PER_TYPE, 'MedicationDispense')).toBe(DISPENSE_ID_SYSTEM)
  })

  // A type the family was never told about is a misconfigured source, not a
  // record to key somewhere arbitrary.
  test('a per-type family throws for a type it does not list', () => {
    expect(() => SystemFamily.systemFor(PER_TYPE, 'Observation')).toThrow(/Observation/)
  })
})

describe('SystemFamily.relativise', () => {
  test("the FHIR style reads the server's absolute spelling of its own record back to the relative one", () => {
    expect(SystemFamily.relativise(FHIR_STYLE)(`${BASE_URL}/Patient/pat-7`)).toBe('Patient/pat-7')
  })

  for (const [label, target] of [
    ['a relative reference', 'Patient/pat-7'],
    ["another server's record", 'https://elsewhere.example/fhir/Patient/pat-7'],
    ['a longer base URL with the same prefix', `${BASE_URL}-staging/Patient/pat-7`],
    ['an empty literal', ''],
  ] as const) {
    test(`the FHIR style leaves ${label} alone`, () => {
      expect(SystemFamily.relativise(FHIR_STYLE)(target)).toBe(target)
    })
  }

  test('a fixed system relativises nothing, its own system included', () => {
    for (const target of [`${SYSTEM}/Patient/pat-7`, 'Patient/pat-7']) {
      expect(SystemFamily.relativise(FIXED)(target)).toBe(target)
    }
  })

  test('a per-type family relativises nothing, its own systems included', () => {
    for (const target of [`${PATIENT_ID_SYSTEM}/Patient/pat-7`, 'Patient/pat-7']) {
      expect(SystemFamily.relativise(PER_TYPE)(target)).toBe(target)
    }
  })
})
