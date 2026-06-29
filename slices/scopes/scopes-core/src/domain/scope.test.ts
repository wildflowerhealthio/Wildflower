import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import type { Fhir, Wildflower } from '../index.ts'
import { AccessRights, Scope } from '../index.ts'

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

describe('Scope.scopeParse — total parse (mirrors Rust Scope)', () => {
  test('classifies flag / fhir / wildflower / unknown', () => {
    expect(Scope.scopeParse('openid')).toEqual({ kind: 'known', scope: 'openid' })
    expect(Scope.scopeParse('launch/patient')).toEqual({ kind: 'known', scope: 'launch/patient' })
    expect(Scope.scopeParse('patient/Observation.rs')).toEqual(
      fhir('patient', 'Observation', AccessRights.letters(['r', 's']))
    )
    expect(Scope.scopeParse('system/*.cruds')).toEqual(
      fhir('system', '*', AccessRights.letters(['c', 'r', 'u', 'd', 's']))
    )
    expect(Scope.scopeParse('wildflower/Grant.read')).toEqual({
      kind: 'wildflower',
      resource: { kind: 'known', resource: 'Grant' },
      access: AccessRights.read,
    })
    expect(Scope.scopeParse('wildflower/*.write')).toEqual({
      kind: 'wildflower',
      resource: { kind: 'wildcard' },
      access: AccessRights.write,
    })
    // wildflower context + unknown resource ⇒ unknown (the set is closed, like Rust)
    expect(Scope.scopeParse('wildflower/Nope.cruds')).toEqual({
      kind: 'unknown',
      raw: 'wildflower/Nope.cruds',
    })
    expect(Scope.scopeParse('patient/Observation.rx')).toEqual({
      kind: 'unknown',
      raw: 'patient/Observation.rx',
    })
    expect(Scope.scopeParse('totally-made-up')).toEqual({ kind: 'unknown', raw: 'totally-made-up' })
  })

  test('FHIR + Wildflower scopes round-trip through serialize → parse', () => {
    const access = fc.oneof(
      fc
        .uniqueArray(fc.constantFrom<AccessRights.Action>('c', 'r', 'u', 'd', 's'), {
          minLength: 1,
        })
        .map((l) => AccessRights.letters(l)),
      fc.constantFrom(AccessRights.read, AccessRights.write, AccessRights.star)
    )
    const fhirArb = fc
      .tuple(
        fc.constantFrom<Fhir.ContextLevel>('patient', 'user', 'system'),
        fc.constantFrom('Observation', 'Patient', '*'),
        access
      )
      .map(([ctx, name, a]): Scope.Scope => fhir(ctx, name, a))
    const wfArb = fc.tuple(fc.constantFrom<Wildflower.Resource>('Grant', 'Client'), access).map(
      ([resource, a]): Scope.Scope => ({
        kind: 'wildflower',
        resource: { kind: 'known', resource },
        access: a,
      })
    )
    fc.assert(
      fc.property(fc.oneof(fhirArb, wfArb), (scope) => {
        expect(Scope.scopeParse(Scope.scopeSerialize(scope))).toEqual(scope)
      })
    )
  })

  test('parseResource returns null for flags/unknowns, the scope otherwise', () => {
    expect(Scope.scopeParseResource('openid')).toBeNull()
    expect(Scope.scopeParseResource('mystery')).toBeNull()
    expect(Scope.scopeParseResource('patient/Observation.r')).toEqual(
      fhir('patient', 'Observation', AccessRights.letters(['r']))
    )
  })
})
