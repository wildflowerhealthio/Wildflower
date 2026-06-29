import { describe, expect, test } from 'vite-plus/test'

import type { Fhir } from '../index.ts'
import { AccessRights, GrantDraft, Scope } from '../index.ts'

const grant = (scopes: Scope.Scope[]): GrantDraft.GrantDraft => ({ subject: 'jordan', scopes })

const fhir = (
  context: Fhir.ContextLevel,
  name: string,
  access: AccessRights.AccessRights
): Scope.Scope => ({
  kind: 'fhir',
  context,
  resource: name === '*' ? { kind: 'wildcard' } : { kind: 'known', name },
  access,
})

describe('GrantDraft.serialize — wildcard dedupe (§3)', () => {
  test('a specific scope omits actions already in the same scope context wildcard', () => {
    const g = grant([
      fhir('patient', '*', AccessRights.letters(['r'])),
      fhir('patient', 'Observation', AccessRights.letters(['c', 'r'])),
    ])
    expect(GrantDraft.serialize(g)).toEqual(['patient/*.r', 'patient/Observation.c'])
  })

  test('a specific scope fully covered by the wildcard emits nothing', () => {
    const g = grant([
      fhir('patient', '*', AccessRights.letters(['r', 's'])),
      fhir('patient', 'Observation', AccessRights.letters(['r'])),
    ])
    expect(GrantDraft.serialize(g)).toEqual(['patient/*.rs'])
  })

  test('a Wildflower wildcard does not dedupe a patient FHIR scope', () => {
    const g = grant([
      { kind: 'wildflower', resource: { kind: 'wildcard' }, access: AccessRights.letters(['r']) },
      fhir('patient', 'Observation', AccessRights.letters(['r'])),
    ])
    expect(GrantDraft.serialize(g)).toContain('patient/Observation.r')
  })
})

describe('GrantDraft.serializeAll', () => {
  test('appends sorted flags and preserved unknowns', () => {
    const g = grant([
      fhir('patient', 'Observation', AccessRights.letters(['r'])),
      Scope.known('offline_access'),
      Scope.known('openid'),
      { kind: 'unknown', raw: 'mystery_scope' },
    ])
    expect(GrantDraft.serializeAll(g)).toEqual([
      'patient/Observation.r',
      'offline_access',
      'openid',
      'mystery_scope',
    ])
  })
})
