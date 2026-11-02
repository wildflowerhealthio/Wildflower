import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { describe, expect, test } from 'vite-plus/test'

import * as FhirRoot from './fhir-root.ts'

/**
 * Covers the two rules a FHIR server's root carries: each type's ids are in
 * their own system under it, and its absolute spelling of its own record is
 * the relative one.
 */

const ROOT = 'https://source.example/baseR4'

const reference = (target: string): typeof IdentifierAndReference.emptyReference => ({
  ...IdentifierAndReference.emptyReference,
  reference: target,
})

describe('FhirRoot', () => {
  test('keys each type in its own system under the root', () => {
    expect(FhirRoot.systemFor(ROOT, 'Patient')).toBe(`${ROOT}/Patient`)
    expect(FhirRoot.systemFor(ROOT, 'Observation')).toBe(`${ROOT}/Observation`)
  })

  test("reads the server's absolute spelling of its own record back to the relative one", () => {
    expect(FhirRoot.relativise(ROOT)(reference(`${ROOT}/Patient/pat-7`))).toEqual(
      reference('Patient/pat-7')
    )
  })

  for (const [label, target] of [
    ['a relative reference', 'Patient/pat-7'],
    ["another server's record", 'https://elsewhere.example/fhir/Patient/pat-7'],
    ['a longer root with the same prefix', `${ROOT}-staging/Patient/pat-7`],
  ] as const) {
    test(`leaves ${label} alone`, () => {
      expect(FhirRoot.relativise(ROOT)(reference(target))).toEqual(reference(target))
    })
  }

  test('leaves a reference with no literal alone', () => {
    expect(FhirRoot.relativise(ROOT)(IdentifierAndReference.emptyReference)).toEqual(
      IdentifierAndReference.emptyReference
    )
  })
})
