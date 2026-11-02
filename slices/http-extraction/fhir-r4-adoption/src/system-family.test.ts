import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { describe, expect, test } from 'vite-plus/test'

import * as SystemFamily from './system-family.ts'

/**
 * Covers which system each family gives a type, and which references each
 * relativises: the FHIR style appends the type to the base URL and reads the
 * server's absolute spelling of its own record back to the relative one; a
 * fixed system is the same whatever the type and relativises nothing.
 */

const BASE_URL = 'https://source.example/baseR4'
const SYSTEM = 'https://wildflowerhealth.io/fhir/sid/example-portal'

const FHIR_STYLE = SystemFamily.FhirStyleBaseUrl({ baseUrl: BASE_URL })
const FIXED = SystemFamily.FixedAcrossResourceTypes({ system: SYSTEM })

const reference = (target: string): typeof IdentifierAndReference.emptyReference => ({
  ...IdentifierAndReference.emptyReference,
  reference: target,
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
})

describe('SystemFamily.relativise', () => {
  test("the FHIR style reads the server's absolute spelling of its own record back to the relative one", () => {
    expect(SystemFamily.relativise(FHIR_STYLE)(reference(`${BASE_URL}/Patient/pat-7`))).toEqual(
      reference('Patient/pat-7')
    )
  })

  for (const [label, target] of [
    ['a relative reference', 'Patient/pat-7'],
    ["another server's record", 'https://elsewhere.example/fhir/Patient/pat-7'],
    ['a longer base URL with the same prefix', `${BASE_URL}-staging/Patient/pat-7`],
  ] as const) {
    test(`the FHIR style leaves ${label} alone`, () => {
      expect(SystemFamily.relativise(FHIR_STYLE)(reference(target))).toEqual(reference(target))
    })
  }

  test('the FHIR style leaves a reference with no literal alone', () => {
    expect(SystemFamily.relativise(FHIR_STYLE)(IdentifierAndReference.emptyReference)).toEqual(
      IdentifierAndReference.emptyReference
    )
  })

  test('a fixed system relativises nothing, its own system included', () => {
    for (const target of [`${SYSTEM}/Patient/pat-7`, 'Patient/pat-7']) {
      expect(SystemFamily.relativise(FIXED)(reference(target))).toEqual(reference(target))
    }
  })
})
