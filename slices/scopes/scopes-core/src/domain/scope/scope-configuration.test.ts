import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Scope from './index.ts'

const patient = new Scope.Contexts.Fhir('patient')
const system = new Scope.Contexts.Fhir('system')
const obs = Scope.ResourceType.Fhir.parse('Observation')!
const anyRecord = Scope.ResourceType.Fhir.parse('*')!
const v2 = Scope.FhirV2.configuration
const v1 = Scope.FhirV1.configuration

const fhirAt = (
  level: Scope.Contexts.Fhir.Level,
  name: string,
  l: Scope.Permission.Cruds.Interaction[]
): Scope.FhirV2 =>
  new Scope.FhirV2(
    new Scope.Contexts.Fhir(level),
    Scope.ResourceType.Fhir.parse(name)!,
    new Scope.Permission.Cruds(l)
  )

const fhirV2 = (name: string, l: Scope.Permission.Cruds.Interaction[]): Scope.FhirV2 =>
  fhirAt('patient', name, l)

/** The stored permission for a patient (context, resource) row within a v2 partition. */
const permAt = (
  owned: Scope.MultiScope['fhirV2'],
  resource: Scope.ResourceType.Fhir
): Scope.Permission.Base<Scope.Permission.Cruds.Interaction> | undefined =>
  owned.find((s) => s.hasContext(patient) && s.hasResource(resource))?.permission

describe('ScopeConfiguration.effectiveCell — coverage + lock (§3)', () => {
  test('a wildcard interaction grants + locks that cell on a specific row', () => {
    expect(
      Scope.ScopeConfiguration.scopesGrantInteraction(
        [fhirAt('patient', '*', ['r'])],
        patient,
        obs,
        'r'
      )
    ).toEqual({ granted: true, grantedAtOwnResource: false })
  })

  test('a specific interaction without a wildcard is granted but not locked', () => {
    expect(
      Scope.ScopeConfiguration.scopesGrantInteraction(
        [fhirAt('patient', 'Observation', ['c'])],
        patient,
        obs,
        'c'
      )
    ).toEqual({ granted: true, grantedAtOwnResource: true })
  })

  test("the wildcard row's own cell is granted but NOT locked", () => {
    expect(
      Scope.ScopeConfiguration.scopesGrantInteraction(
        [fhirAt('patient', '*', ['r'])],
        patient,
        anyRecord,
        'r'
      )
    ).toEqual({ granted: true, grantedAtOwnResource: true })
  })

  test('a higher context covers + locks a lower one (system ⊇ patient)', () => {
    expect(
      Scope.ScopeConfiguration.scopesGrantInteraction(
        [fhirAt('system', '*', ['r'])],
        patient,
        obs,
        'r'
      )
    ).toEqual({ granted: true, grantedAtOwnResource: false })
  })

  test('a lower context does NOT cover a higher one (patient ⊉ system)', () => {
    expect(
      Scope.ScopeConfiguration.scopesGrantInteraction(
        [fhirAt('patient', '*', ['r'])],
        system,
        obs,
        'r'
      )
    ).toEqual({ granted: false, grantedAtOwnResource: true })
  })
})

describe('ScopeConfiguration.toggleItem — interaction cells (v2)', () => {
  test('adds an interaction in canonical order', () => {
    const next = v2.toggleItem([fhirV2('Observation', ['s'])], patient, obs, 'c')
    expect(permAt(next, obs)?.toArray()).toEqual(['c', 's'])
  })

  test('removing the last interaction drops the specific row', () => {
    const next = v2.toggleItem([fhirV2('Observation', ['r'])], patient, obs, 'r')
    expect(permAt(next, obs)).toBeUndefined()
  })

  test('toggling a fresh (ungranted) row creates it', () => {
    const next = v2.toggleItem([], patient, obs, 'c')
    expect(permAt(next, obs)?.toArray()).toEqual(['c'])
  })

  test('a wildcard-locked cell is a no-op', () => {
    const scopes = [fhirV2('*', ['r']), fhirV2('Observation', ['c'])]
    expect(v2.toggleItem(scopes, patient, obs, 'r')).toEqual(scopes)
  })

  test('toggling the same unlocked cell twice is identity on its letters (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.constantFrom<Scope.Permission.Cruds.Interaction>('c', 'r', 'u', 'd', 's'),
          {
            minLength: 1,
          }
        ),
        fc.constantFrom<Scope.Permission.Cruds.Interaction>('c', 'r', 'u', 'd', 's'),
        (start, id) => {
          const once = v2.toggleItem([fhirV2('Observation', start)], patient, obs, id)
          const twice = v2.toggleItem(once, patient, obs, id)
          expect(new Set(permAt(twice, obs)?.toArray() ?? [])).toEqual(new Set(start))
        }
      )
    )
  })
})

describe('ScopeConfiguration.toggleItem — v1 Read/Write words', () => {
  const readScope = (): Scope.FhirV1 =>
    new Scope.FhirV1(patient, obs, Scope.Permission.ReadWrite.read)
  const permAtV1 = (
    owned: Scope.MultiScope['fhirV1']
  ): Scope.Permission.Base<Scope.Permission.ReadWrite.Interaction> | undefined =>
    owned.find((s) => s.hasContext(patient) && s.hasResource(obs))?.permission

  test('adding Write to a Read scope makes it * (both)', () => {
    const next = v1.toggleItem([readScope()], patient, obs, 'write')
    expect(permAtV1(next)).toEqual(Scope.Permission.ReadWrite.star)
  })

  test('removing the only word drops the row', () => {
    const next = v1.toggleItem([readScope()], patient, obs, 'read')
    expect(permAtV1(next)).toBeUndefined()
  })

  test('toggling on an empty row creates that word', () => {
    const next = v1.toggleItem([], patient, obs, 'write')
    expect(permAtV1(next)).toEqual(Scope.Permission.ReadWrite.write)
  })
})
