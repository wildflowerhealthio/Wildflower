import { describe, expect, test } from 'vite-plus/test'

import { Grant } from './index.ts'

describe('Grant.parse / render', () => {
  test('parse is total and render round-trips each scope in order', () => {
    const raw = ['openid', 'patient/Observation.rs', 'wildflower/Grant.cruds', 'a_stray_unknown']
    const grant = Grant.parse(raw)
    // Nothing dropped — the stray string is preserved as an unknown scope.
    expect(grant.scopes).toHaveLength(4)
    expect(Grant.render(grant)).toEqual(raw)
  })

  test('make wraps an existing scope list', () => {
    const { scopes } = Grant.parse(['openid'])
    expect(Grant.make(scopes).scopes).toBe(scopes)
  })
})

describe('Grant kind projections', () => {
  const { scopes } = Grant.parse([
    'openid',
    'offline_access',
    'patient/Observation.rs',
    'wildflower/Grant.cruds',
    'a_stray_unknown',
  ])

  test('resourceScopes keeps only FHIR + Wildflower scopes', () => {
    expect(Grant.resourceScopes(scopes).map((s) => s.kind)).toEqual(['fhir', 'wildflower'])
  })

  test('knownScopes keeps the flag scopes in order', () => {
    expect(Grant.knownScopes(scopes)).toEqual(['openid', 'offline_access'])
  })

  test('unknownScopes preserves the raw verbatim', () => {
    expect(Grant.unknownScopes(scopes)).toEqual(['a_stray_unknown'])
  })

  test('hasKnown reports flag membership', () => {
    expect(Grant.hasKnown(scopes, 'openid')).toBe(true)
    expect(Grant.hasKnown(scopes, 'fhirUser')).toBe(false)
  })
})
