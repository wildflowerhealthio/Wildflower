import { describe, expect, test } from 'vite-plus/test'

import { Grant, Scope } from './index.ts'

const patient = Scope.Contexts.Fhir.patient
const obs = Scope.ResourceType.Fhir.parse('Observation')!
const cruds = (l: Scope.Permission.Cruds.Interaction[]): Scope.Permission.Cruds =>
  new Scope.Permission.Cruds(l)

describe('Grant.parse / render', () => {
  test('parse is total — nothing is dropped and every scope round-trips', () => {
    const raw = ['openid', 'patient/Observation.rs', 'wildflower/Grant.cruds', 'a_stray_unknown']
    // `render` groups by kind (unknown, known, fhirV1, fhirV2, wildflower), so the
    // guarantee is totality + round-trip, not cross-kind order — compare as a multiset.
    expect([...Grant.render(Grant.parse(raw))].toSorted()).toEqual([...raw].toSorted())
  })

  test('make partitions a scope list by kind', () => {
    const grant = Grant.make([Scope.Known.openid, new Scope.FhirV2(patient, obs, cruds(['r']))])
    expect(grant.known.map((k) => k.name)).toEqual(['openid'])
    expect(grant.fhirV2).toHaveLength(1)
  })
})

describe('Grant kind projections', () => {
  const grant = Grant.parse([
    'openid',
    'offline_access',
    'patient/Observation.rs',
    'wildflower/Grant.cruds',
    'a_stray_unknown',
  ])

  test('resourceScopes keeps only FHIR + Wildflower scopes', () => {
    expect(Grant.resourceScopes(grant).map((s) => s.kind)).toEqual(['fhirV2', 'wildflower'])
  })

  test('the known partition keeps the flag scopes in order', () => {
    expect(grant.known.map((k) => k.name)).toEqual(['openid', 'offline_access'])
  })

  test('the unknown partition preserves the raw verbatim', () => {
    expect(grant.unknown.map((u) => u.serialize())).toEqual(['a_stray_unknown'])
  })

  test('hasKnown reports flag membership by value', () => {
    expect(Grant.hasKnown(grant.known, Scope.Known.openid)).toBe(true)
    expect(Grant.hasKnown(grant.known, Scope.Known.fhirUser)).toBe(false)
  })
})
