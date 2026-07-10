import { GrantDraft } from 'scopes-core'
import { describe, expect, test } from 'vite-plus/test'

import { exclusionStatementsFrom } from './exclusion-statements.ts'

/** A draft granting exactly `scopes` — what a consent surface's live draft holds. */
const draft = (scopes: readonly string[]): GrantDraft.GrantDraft =>
  GrantDraft.fromScopes(scopes, null)

describe('exclusionStatementsFrom — presence/absence rules', () => {
  test('all four excluded lines when the draft is a single narrow patient scope', () => {
    const keys = exclusionStatementsFrom(draft(['patient/Observation.r'])).map((e) => e.key)
    expect(keys).toEqual(['other-record-types', 'admin', 'offline', 'other-patients'])
  })

  test('the read/write exclusions state the verbs in their copy', () => {
    const labels = exclusionStatementsFrom(draft(['patient/Observation.r'])).map((e) => e.label)
    expect(labels).toEqual([
      'Read or write other health record types',
      'Read or write admin settings & connected apps',
      'Access your data after 15 minutes',
      'Read or write records for other patients',
    ])
  })

  test('a FHIR wildcard drops "other health record types"', () => {
    const keys = exclusionStatementsFrom(draft(['patient/*.r'])).map((e) => e.key)
    expect(keys).not.toContain('other-record-types')
  })

  test('a wildflower scope drops the admin line', () => {
    const keys = exclusionStatementsFrom(draft(['wildflower/Client.r'])).map((e) => e.key)
    expect(keys).not.toContain('admin')
  })

  test('offline_access drops the background line', () => {
    const keys = exclusionStatementsFrom(draft(['offline_access'])).map((e) => e.key)
    expect(keys).not.toContain('offline')
  })

  test('a system-context scope drops the other-patients line', () => {
    const keys = exclusionStatementsFrom(draft(['system/Observation.r'])).map((e) => e.key)
    expect(keys).not.toContain('other-patients')
  })

  test('an empty draft (nothing granted yet) still lists every exclusion', () => {
    const keys = exclusionStatementsFrom(draft([])).map((e) => e.key)
    expect(keys).toEqual(['other-record-types', 'admin', 'offline', 'other-patients'])
  })
})
