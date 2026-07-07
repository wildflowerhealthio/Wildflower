import { ScopeRequest } from 'scopes-core'
import { describe, expect, test } from 'vite-plus/test'

import { exclusionStatements } from './exclusion-statements.ts'

/** The all-optional request derived from a plain requested-scope list. */
const req = (scopes: readonly string[]): ScopeRequest.ScopeRequest =>
  ScopeRequest.fromRequestedScopes({ optional: scopes })

describe('exclusionStatements — presence/absence rules', () => {
  test('all four excluded lines when the request is a single narrow patient scope', () => {
    const keys = exclusionStatements(req(['patient/Observation.r'])).map((e) => e.key)
    expect(keys).toEqual(['other-record-types', 'admin', 'offline', 'other-patients'])
  })

  test('the read/write exclusions state the verbs in their copy', () => {
    const labels = exclusionStatements(req(['patient/Observation.r'])).map((e) => e.label)
    expect(labels).toEqual([
      'Read or write other health record types',
      'Read or write admin settings & connected apps',
      'Stay connected in the background',
      'Read or write records for other patients',
    ])
  })

  test('a FHIR wildcard drops "other health record types"', () => {
    const keys = exclusionStatements(req(['patient/*.r'])).map((e) => e.key)
    expect(keys).not.toContain('other-record-types')
  })

  test('a wildflower scope drops the admin line', () => {
    const keys = exclusionStatements(req(['wildflower/Client.r'])).map((e) => e.key)
    expect(keys).not.toContain('admin')
  })

  test('offline_access drops the background line', () => {
    const keys = exclusionStatements(req(['offline_access'])).map((e) => e.key)
    expect(keys).not.toContain('offline')
  })

  test('a system-context scope drops the other-patients line', () => {
    const keys = exclusionStatements(req(['system/Observation.r'])).map((e) => e.key)
    expect(keys).not.toContain('other-patients')
  })
})
