import { describe, expect, test } from 'vite-plus/test'

import * as SystemFamily from './system-family.ts'

/**
 * Covers which system each family gives a type: the FHIR style appends the
 * type to the base URL, a fixed system is the same whatever the type.
 */

const BASE_URL = 'https://source.example/baseR4'
const SYSTEM = 'https://wildflowerhealth.io/fhir/sid/example-portal'

describe('SystemFamily.systemFor', () => {
  test('the FHIR style appends the type to the base URL', () => {
    const family = SystemFamily.FhirStyleBaseUrl({ baseUrl: BASE_URL })
    expect(SystemFamily.systemFor(family, 'Patient')).toBe(`${BASE_URL}/Patient`)
    expect(SystemFamily.systemFor(family, 'Observation')).toBe(`${BASE_URL}/Observation`)
  })

  test('a fixed system is the same whatever the type', () => {
    const family = SystemFamily.FixedAcrossResourceTypes({ system: SYSTEM })
    expect(SystemFamily.systemFor(family, 'Patient')).toBe(SYSTEM)
    expect(SystemFamily.systemFor(family, 'Observation')).toBe(SYSTEM)
  })
})
