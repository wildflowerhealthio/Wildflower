import { describe, expect, test } from 'vite-plus/test'

import { Grant, type GrantDraft, Scope, ScopeRequest } from '../index.ts'

const patient = new Scope.Contexts.Fhir('patient')

const fhirV2 = (name: string, l: Scope.Permission.Cruds.Interaction[]): Scope.FhirV2 =>
  new Scope.FhirV2(patient, Scope.ResourceType.Fhir.parse(name)!, new Scope.Permission.Cruds(l))

const request = (
  requested: Scope.Any[],
  required: Scope.Any[] = []
): ScopeRequest.ScopeRequest => ({
  requested: Grant.make(requested),
  required: Grant.make(required),
})

const grant = (scopes: Scope.Any[]): GrantDraft.GrantDraft => ({
  patient: 'jordan',
  ...Grant.make(scopes),
})

describe('ScopeRequest flags — §2 / §7', () => {
  test('flagDisabled: open mode never disables; request mode disables the un-requested', () => {
    expect(ScopeRequest.flagDisabled(null, 'openid')).toBe(false)
    const req = request([Scope.Known.openid])
    expect(ScopeRequest.flagDisabled(req, 'openid')).toBe(false)
    expect(ScopeRequest.flagDisabled(req, 'offline_access')).toBe(true)
  })

  test('flagRequired: true only for a flag in the required subset', () => {
    const req = request([Scope.Known.openid, Scope.Known.profile], [Scope.Known.openid])
    expect(ScopeRequest.flagRequired(req, 'openid')).toBe(true)
    expect(ScopeRequest.flagRequired(req, 'profile')).toBe(false)
    expect(ScopeRequest.flagRequired(null, 'openid')).toBe(false)
  })
})

describe('ScopeRequest.isWithin — granted ⊆ requested (§2)', () => {
  test('open mode is always within', () => {
    expect(ScopeRequest.isWithin(grant([fhirV2('Observation', ['r'])]), null)).toBe(true)
  })

  test('a grant within the envelope passes; one exceeding it fails', () => {
    const req = request([fhirV2('Observation', ['r', 'c'])])
    expect(ScopeRequest.isWithin(grant([fhirV2('Observation', ['r'])]), req)).toBe(true)
    expect(ScopeRequest.isWithin(grant([fhirV2('Observation', ['r', 'u'])]), req)).toBe(false)
  })

  test('a wildcard request covers concrete grants beneath it', () => {
    // `patient/*.rs` requested ⇒ `patient/Observation.r` is within (was a false negative
    // under exact `(context, resource)` matching).
    const req = request([fhirV2('*', ['r', 's'])])
    expect(ScopeRequest.isWithin(grant([fhirV2('Observation', ['r'])]), req)).toBe(true)
    // ...but an interaction the wildcard request lacks still exceeds it.
    expect(ScopeRequest.isWithin(grant([fhirV2('Observation', ['c'])]), req)).toBe(false)
  })

  test('a granted flag outside the requested flags fails', () => {
    const req = request([Scope.Known.openid])
    expect(ScopeRequest.isWithin(grant([Scope.Known.openid]), req)).toBe(true)
    expect(ScopeRequest.isWithin(grant([Scope.Known.offlineAccess]), req)).toBe(false)
  })
})
