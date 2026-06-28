import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { lettersAccess, wordAccess } from './access.ts'
import type { AccessWord, Action, Context, Grant, ScopePermission } from './model.ts'
import {
  parsePermission,
  parseScope,
  serializeAll,
  serializeGrant,
  serializePermission,
} from './serialize.ts'

const grant = (permissions: ScopePermission[], flags: Grant['flags'] = []): Grant => ({
  subject: 'jordan',
  permissions,
  flags,
})

describe('serializePermission', () => {
  test('renders context/Resource.perms; empty letters → empty string', () => {
    expect(
      serializePermission({
        context: 'patient',
        resource: 'Observation',
        access: lettersAccess(['c', 'r', 's']),
      })
    ).toBe('patient/Observation.crs')
    expect(
      serializePermission({ context: 'system', resource: '*', access: wordAccess('star') })
    ).toBe('system/*.*')
    expect(
      serializePermission({ context: 'patient', resource: 'X', access: lettersAccess([]) })
    ).toBe('')
  })
})

describe('parseScope — total parse (mirrors Rust Scope)', () => {
  test('classifies flag / resource / unknown', () => {
    expect(parseScope('openid')).toEqual({ kind: 'flag', flag: 'openid' })
    expect(parseScope('launch/patient')).toEqual({ kind: 'flag', flag: 'launch/patient' })
    expect(parseScope('patient/Observation.rs')).toEqual({
      kind: 'resource',
      permission: {
        context: 'patient',
        resource: 'Observation',
        access: lettersAccess(['r', 's']),
      },
    })
    expect(parseScope('wildflower/Grant.read')).toEqual({
      kind: 'resource',
      permission: { context: 'wildflower', resource: 'Grant', access: wordAccess('read') },
    })
    expect(parseScope('patient/Observation.rx')).toEqual({
      kind: 'unknown',
      raw: 'patient/Observation.rx',
    })
    expect(parseScope('totally-made-up')).toEqual({ kind: 'unknown', raw: 'totally-made-up' })
  })

  test('resource scopes round-trip through serialize → parse', () => {
    const ctx = fc.constantFrom<Context>('patient', 'user', 'system', 'wildflower')
    const resource = fc.constantFrom('Observation', 'Patient', 'Grant', '*')
    const accessArb = fc.oneof(
      fc
        .uniqueArray(fc.constantFrom<Action>('c', 'r', 'u', 'd', 's'), { minLength: 1 })
        .map((l) => lettersAccess(l)),
      fc.constantFrom<AccessWord>('read', 'write', 'star').map((w) => wordAccess(w))
    )
    fc.assert(
      fc.property(ctx, resource, accessArb, (context, res, access) => {
        const permission: ScopePermission = { context, resource: res, access }
        expect(parsePermission(serializePermission(permission))).toEqual(permission)
      })
    )
  })
})

describe('serializeGrant — wildcard dedupe (§3)', () => {
  test('a specific scope omits actions already in the same-context wildcard', () => {
    const g = grant([
      { context: 'patient', resource: '*', access: lettersAccess(['r']) },
      { context: 'patient', resource: 'Observation', access: lettersAccess(['c', 'r']) },
    ])
    // patient/Observation.r is redundant with patient/*.r → only .c remains.
    expect(serializeGrant(g)).toEqual(['patient/*.r', 'patient/Observation.c'])
  })

  test('a specific scope fully covered by the wildcard emits nothing', () => {
    const g = grant([
      { context: 'patient', resource: '*', access: lettersAccess(['r', 's']) },
      { context: 'patient', resource: 'Observation', access: lettersAccess(['r']) },
    ])
    expect(serializeGrant(g)).toEqual(['patient/*.rs'])
  })

  test('no emitted specific scope repeats a wildcard-covered action (property)', () => {
    const g = grant([
      { context: 'patient', resource: '*', access: lettersAccess(['r', 's']) },
      { context: 'patient', resource: 'Observation', access: lettersAccess(['c', 'r', 'u', 's']) },
      { context: 'patient', resource: 'Condition', access: lettersAccess(['r', 's']) },
    ])
    const scopes = serializeGrant(g)
    const specifics = scopes.filter((s) => !s.includes('/*.'))
    for (const s of specifics) {
      const perms = s.split('.').at(-1) ?? ''
      expect(perms.includes('r')).toBe(false) // r and s are wildcard-covered
      expect(perms.includes('s')).toBe(false)
    }
  })

  test('admin (wildflower) wildcard does not dedupe a patient scope', () => {
    const g = grant([
      { context: 'wildflower', resource: '*', access: lettersAccess(['r']) },
      { context: 'patient', resource: 'Observation', access: lettersAccess(['r']) },
    ])
    expect(serializeGrant(g)).toContain('patient/Observation.r')
  })
})

describe('serializeAll', () => {
  test('appends sorted flag scopes', () => {
    const g = grant(
      [{ context: 'patient', resource: 'Observation', access: lettersAccess(['r']) }],
      ['offline_access', 'openid']
    )
    expect(serializeAll(g)).toEqual(['patient/Observation.r', 'offline_access', 'openid'])
  })
})
