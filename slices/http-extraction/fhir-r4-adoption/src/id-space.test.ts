import { describe, expect, test } from 'vite-plus/test'

import * as IdSpace from './id-space.ts'

/**
 * Covers where each kind of source keys a type: a FHIR server per type under
 * its base, a portal in its one system, and an id-less record in the shared
 * content-digest system.
 */

const BASE = 'https://source.example/baseR4'
const SYSTEM = 'https://wildflowerhealth.io/fhir/sid/example-portal'

describe('IdSpace', () => {
  test('a FHIR server keys each type under its base', () => {
    const idSpaceOf = IdSpace.inFhirServer(BASE)
    expect(idSpaceOf('Patient')).toBe(`${BASE}/Patient`)
    expect(idSpaceOf('Observation')).toBe(`${BASE}/Observation`)
  })

  test('a portal keys every type in its one system', () => {
    const idSpaceOf = IdSpace.inSystem(SYSTEM)
    expect(idSpaceOf('Patient')).toBe(SYSTEM)
    expect(idSpaceOf('Observation')).toBe(SYSTEM)
  })

  test('a record with no source id is keyed in a Wildflower identifier system', () => {
    expect(IdSpace.CONTENT_DIGEST).toBe(
      'https://wildflowerhealth.io/fhir/identifier/content-digest'
    )
  })
})
