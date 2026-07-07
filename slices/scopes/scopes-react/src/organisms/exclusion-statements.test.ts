import { ScopeRequest } from 'scopes-core'
import { describe, expect, test } from 'vite-plus/test'

import { exclusionStatementsFrom } from './exclusion-statements.ts'

/** The all-optional request derived from a plain requested-scope list. */
const req = (scopes: readonly string[]): ScopeRequest.ScopeRequest =>
  ScopeRequest.fromRequestedScopes({ optional: scopes })

describe('exclusionStatementsFrom — presence/absence rules', () => {
  test('all four excluded lines when the request is a single narrow patient scope', () => {
    const keys = exclusionStatementsFrom(req(['patient/Observation.r'])).map((e) => e.key)
    expect(keys).toEqual(['other-record-types', 'admin', 'offline', 'other-patients'])
  })

  test('the read/write exclusions state the verbs in their copy', () => {
    const labels = exclusionStatementsFrom(req(['patient/Observation.r'])).map((e) => e.label)
    expect(labels).toEqual([
      'Read or write other health record types',
      'Read or write admin settings & connected apps',
      'Stay connected in the background',
      'Read or write records for other patients',
    ])
  })

  test('a FHIR wildcard drops "other health record types"', () => {
    const keys = exclusionStatementsFrom(req(['patient/*.r'])).map((e) => e.key)
    expect(keys).not.toContain('other-record-types')
  })

  test('a wildflower scope drops the admin line', () => {
    const keys = exclusionStatementsFrom(req(['wildflower/Client.r'])).map((e) => e.key)
    expect(keys).not.toContain('admin')
  })

  test('offline_access drops the background line', () => {
    const keys = exclusionStatementsFrom(req(['offline_access'])).map((e) => e.key)
    expect(keys).not.toContain('offline')
  })

  test('a system-context scope drops the other-patients line', () => {
    const keys = exclusionStatementsFrom(req(['system/Observation.r'])).map((e) => e.key)
    expect(keys).not.toContain('other-patients')
  })
})
