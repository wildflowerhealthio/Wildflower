import { describe, expect, test } from 'vite-plus/test'

import * as SourceIdentity from './source-identity.ts'

/**
 * Covers which system each kind of source keys a type in: a FHIR server per
 * type under its root, a one-system source in that system whatever the type.
 */

const ROOT = 'https://source.example/baseR4'
const SYSTEM = 'https://wildflowerhealth.io/fhir/sid/example-portal'

describe('SourceIdentity.systemFor', () => {
  test('a FHIR server keys each type under its root', () => {
    const source = SourceIdentity.FhirServer({ root: ROOT })
    expect(SourceIdentity.systemFor(source, 'Patient')).toBe(`${ROOT}/Patient`)
    expect(SourceIdentity.systemFor(source, 'Observation')).toBe(`${ROOT}/Observation`)
  })

  test('a one-system source keys every type in that system', () => {
    const source = SourceIdentity.OneSystem({ system: SYSTEM })
    expect(SourceIdentity.systemFor(source, 'Patient')).toBe(SYSTEM)
    expect(SourceIdentity.systemFor(source, 'Observation')).toBe(SYSTEM)
  })
})
