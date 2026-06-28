import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { lettersAccess, readAccess, starAccess, writeAccess } from './access.ts'
import type { Access, Action, ContextLevel, Grant, Scope, WildflowerResource } from './model.ts'
import { knownScope } from './scope.ts'
import { parseScope, serializeAll, serializeGrant, serializeScope } from './serialize.ts'

const grant = (scopes: Scope[]): Grant => ({ subject: 'jordan', scopes })

const fhir = (context: ContextLevel, name: string, access: Access): Scope => ({
  kind: 'fhir',
  context,
  resource: name === '*' ? { kind: 'wildcard' } : { kind: 'known', name },
  access,
})

describe('parseScope — total parse (mirrors Rust Scope)', () => {
  test('classifies flag / fhir / wildflower / unknown', () => {
    expect(parseScope('openid')).toEqual({ kind: 'known', scope: 'openid' })
    expect(parseScope('launch/patient')).toEqual({ kind: 'known', scope: 'launch/patient' })
    expect(parseScope('patient/Observation.rs')).toEqual(
      fhir('patient', 'Observation', lettersAccess(['r', 's']))
    )
    expect(parseScope('system/*.cruds')).toEqual(
      fhir('system', '*', lettersAccess(['c', 'r', 'u', 'd', 's']))
    )
    expect(parseScope('wildflower/Grant.read')).toEqual({
      kind: 'wildflower',
      resource: { kind: 'known', resource: 'Grant' },
      access: readAccess,
    })
    expect(parseScope('wildflower/*.write')).toEqual({
      kind: 'wildflower',
      resource: { kind: 'wildcard' },
      access: writeAccess,
    })
    // wildflower context + unknown resource ⇒ unknown (the set is closed, like Rust)
    expect(parseScope('wildflower/Nope.cruds')).toEqual({
      kind: 'unknown',
      raw: 'wildflower/Nope.cruds',
    })
    expect(parseScope('patient/Observation.rx')).toEqual({
      kind: 'unknown',
      raw: 'patient/Observation.rx',
    })
    expect(parseScope('totally-made-up')).toEqual({ kind: 'unknown', raw: 'totally-made-up' })
  })

  test('FHIR + Wildflower scopes round-trip through serialize → parse', () => {
    const access = fc.oneof(
      fc
        .uniqueArray(fc.constantFrom<Action>('c', 'r', 'u', 'd', 's'), { minLength: 1 })
        .map((l) => lettersAccess(l)),
      fc.constantFrom(readAccess, writeAccess, starAccess)
    )
    const fhirArb = fc
      .tuple(
        fc.constantFrom<ContextLevel>('patient', 'user', 'system'),
        fc.constantFrom('Observation', 'Patient', '*'),
        access
      )
      .map(([ctx, name, a]): Scope => fhir(ctx, name, a))
    const wfArb = fc.tuple(fc.constantFrom<WildflowerResource>('Grant', 'Client'), access).map(
      ([resource, a]): Scope => ({
        kind: 'wildflower',
        resource: { kind: 'known', resource },
        access: a,
      })
    )
    fc.assert(
      fc.property(fc.oneof(fhirArb, wfArb), (scope) => {
        expect(parseScope(serializeScope(scope))).toEqual(scope)
      })
    )
  })
})

describe('serializeGrant — wildcard dedupe (§3)', () => {
  test('a specific scope omits actions already in the same-bucket wildcard', () => {
    const g = grant([
      fhir('patient', '*', lettersAccess(['r'])),
      fhir('patient', 'Observation', lettersAccess(['c', 'r'])),
    ])
    expect(serializeGrant(g)).toEqual(['patient/*.r', 'patient/Observation.c'])
  })

  test('a specific scope fully covered by the wildcard emits nothing', () => {
    const g = grant([
      fhir('patient', '*', lettersAccess(['r', 's'])),
      fhir('patient', 'Observation', lettersAccess(['r'])),
    ])
    expect(serializeGrant(g)).toEqual(['patient/*.rs'])
  })

  test('a Wildflower wildcard does not dedupe a patient FHIR scope', () => {
    const g = grant([
      { kind: 'wildflower', resource: { kind: 'wildcard' }, access: lettersAccess(['r']) },
      fhir('patient', 'Observation', lettersAccess(['r'])),
    ])
    expect(serializeGrant(g)).toContain('patient/Observation.r')
  })
})

describe('serializeAll', () => {
  test('appends sorted flags and preserved unknowns', () => {
    const g = grant([
      fhir('patient', 'Observation', lettersAccess(['r'])),
      knownScope('offline_access'),
      knownScope('openid'),
      { kind: 'unknown', raw: 'mystery_scope' },
    ])
    expect(serializeAll(g)).toEqual([
      'patient/Observation.r',
      'offline_access',
      'openid',
      'mystery_scope',
    ])
  })
})
