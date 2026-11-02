import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { describe, expect, test } from 'vite-plus/test'

import * as FhirBaseUrl from './fhir-base-url.ts'

/**
 * Covers the two rules a FHIR server's base URL carries: each type's ids are
 * in their own system under it, and its absolute spelling of its own record
 * is the relative one.
 */

const BASE_URL = 'https://source.example/baseR4'

const reference = (target: string): typeof IdentifierAndReference.emptyReference => ({
  ...IdentifierAndReference.emptyReference,
  reference: target,
})

describe('FhirBaseUrl', () => {
  test('keys each type in its own system under the base URL', () => {
    expect(FhirBaseUrl.systemFor(BASE_URL, 'Patient')).toBe(`${BASE_URL}/Patient`)
    expect(FhirBaseUrl.systemFor(BASE_URL, 'Observation')).toBe(`${BASE_URL}/Observation`)
  })

  test("reads the server's absolute spelling of its own record back to the relative one", () => {
    expect(FhirBaseUrl.relativise(BASE_URL)(reference(`${BASE_URL}/Patient/pat-7`))).toEqual(
      reference('Patient/pat-7')
    )
  })

  for (const [label, target] of [
    ['a relative reference', 'Patient/pat-7'],
    ["another server's record", 'https://elsewhere.example/fhir/Patient/pat-7'],
    ['a longer base URL with the same prefix', `${BASE_URL}-staging/Patient/pat-7`],
  ] as const) {
    test(`leaves ${label} alone`, () => {
      expect(FhirBaseUrl.relativise(BASE_URL)(reference(target))).toEqual(reference(target))
    })
  }

  test('leaves a reference with no literal alone', () => {
    expect(FhirBaseUrl.relativise(BASE_URL)(IdentifierAndReference.emptyReference)).toEqual(
      IdentifierAndReference.emptyReference
    )
  })
})
