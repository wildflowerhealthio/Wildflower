import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import type { Fhir, GrantDraft, Scope } from '../index.ts'
import { AccessRights, ScopeContext, ScopeRequest } from '../index.ts'

const b = ScopeContext.fhir('patient')
const grant = (scopes: Scope.Scope[]): GrantDraft.GrantDraft => ({ subject: 'jordan', scopes })

const fhir = (name: string, access = AccessRights.letters(['r'])): Fhir.FhirResourceScope => ({
  kind: 'fhir',
  context: 'patient',
  resource: name === '*' ? { kind: 'wildcard' } : { kind: 'known', name },
  access,
})

describe('ScopeRequest.buildCell — clamp (§2) + wildcard lock (§3)', () => {
  const scopeRequest: ScopeRequest.ScopeRequest = {
    resources: [
      fhir('Observation', AccessRights.letters(['c', 'r', 's'])),
      { ...fhir('Condition', AccessRights.letters(['r'])), required: true },
    ],
    flags: [],
  }

  test('action outside the request → disabled', () => {
    expect(ScopeRequest.buildCell(grant([]), scopeRequest, b, 'Observation', 'd').state).toBe(
      'disabled'
    )
  })

  test('a resource not in the scope request → disabled', () => {
    expect(ScopeRequest.buildCell(grant([]), scopeRequest, b, 'Goal', 'r').state).toBe('disabled')
  })

  test('requested + required → locked on', () => {
    expect(
      ScopeRequest.buildCell(grant([fhir('Condition')]), scopeRequest, b, 'Condition', 'r')
    ).toEqual({
      state: 'locked',
      lockReason: 'Required by the app',
    })
  })

  test('requested + optional → on when granted, off when not', () => {
    expect(
      ScopeRequest.buildCell(grant([fhir('Observation')]), scopeRequest, b, 'Observation', 'r')
        .state
    ).toBe('on')
    expect(ScopeRequest.buildCell(grant([]), scopeRequest, b, 'Observation', 'r').state).toBe('off')
  })

  test('open mode: wildcard-covered cell → locked', () => {
    expect(ScopeRequest.buildCell(grant([fhir('*')]), null, b, 'Observation', 'r')).toEqual({
      state: 'locked',
      lockReason: 'Granted by ✶ All record types',
    })
  })
})

describe('ScopeRequest.buildWordCell — v1 Read/Write clamp (§2)', () => {
  test('a component the request does not cover is disabled', () => {
    const scopeRequest: ScopeRequest.ScopeRequest = {
      resources: [fhir('Observation', AccessRights.read)],
      flags: [],
    }
    expect(
      ScopeRequest.buildWordCell(grant([]), scopeRequest, b, 'Observation', 'write').state
    ).toBe('disabled')
    expect(
      ScopeRequest.buildWordCell(grant([]), scopeRequest, b, 'Observation', 'read').state
    ).toBe('off')
  })

  test('required ⇒ locked; open mode ⇒ on/off by the grant', () => {
    const scopeRequest: ScopeRequest.ScopeRequest = {
      resources: [{ ...fhir('Observation', AccessRights.star), required: true }],
      flags: [],
    }
    expect(
      ScopeRequest.buildWordCell(grant([]), scopeRequest, b, 'Observation', 'read').state
    ).toBe('locked')
    expect(
      ScopeRequest.buildWordCell(
        grant([fhir('Observation', AccessRights.read)]),
        null,
        b,
        'Observation',
        'read'
      ).state
    ).toBe('on')
    expect(
      ScopeRequest.buildWordCell(
        grant([fhir('Observation', AccessRights.read)]),
        null,
        b,
        'Observation',
        'write'
      ).state
    ).toBe('off')
  })
})

describe('ScopeRequest.accessForm', () => {
  test('request mode follows the requested form (v1 stays v1)', () => {
    const scopeRequest: ScopeRequest.ScopeRequest = {
      resources: [fhir('Observation', AccessRights.star)],
      flags: [],
    }
    expect(ScopeRequest.accessForm(grant([]), scopeRequest, b, 'Observation')).toBe('word')
  })

  test('open mode follows the grant row, defaulting to letters', () => {
    expect(ScopeRequest.accessForm(grant([]), null, b, 'Observation')).toBe('letters')
    expect(
      ScopeRequest.accessForm(
        grant([fhir('Observation', AccessRights.read)]),
        null,
        b,
        'Observation'
      )
    ).toBe('word')
  })
})

describe('flag clamping', () => {
  const scopeRequest: ScopeRequest.ScopeRequest = {
    resources: [],
    flags: [{ scope: 'openid', required: true }, { scope: 'profile' }],
  }

  test('required vs optional flags', () => {
    expect(ScopeRequest.flagRequired(scopeRequest, 'openid')).toBe(true)
    expect(ScopeRequest.flagRequired(scopeRequest, 'profile')).toBe(false)
  })

  test('not-requested flags are disabled; open mode never disables', () => {
    expect(ScopeRequest.flagDisabled(scopeRequest, 'offline_access')).toBe(true)
    expect(ScopeRequest.flagDisabled(scopeRequest, 'openid')).toBe(false)
    expect(ScopeRequest.flagDisabled(null, 'offline_access')).toBe(false)
  })
})

describe('ScopeRequest.isWithin — granted ⊆ requested (§2)', () => {
  test('true in open mode', () => {
    expect(ScopeRequest.isWithin(grant([fhir('Observation', AccessRights.star)]), null)).toBe(true)
  })

  test('false when a granted action exceeds the request', () => {
    const scopeRequest: ScopeRequest.ScopeRequest = {
      resources: [fhir('Observation', AccessRights.letters(['r']))],
      flags: [],
    }
    expect(
      ScopeRequest.isWithin(
        grant([fhir('Observation', AccessRights.letters(['r', 'c']))]),
        scopeRequest
      )
    ).toBe(false)
  })

  test('any sub-grant of the requested letters stays within (property)', () => {
    const arb = fc.uniqueArray(fc.constantFrom<AccessRights.Action>('c', 'r', 'u', 'd', 's'), {
      minLength: 1,
    })
    fc.assert(
      fc.property(
        arb,
        fc.uniqueArray(fc.constantFrom<AccessRights.Action>('c', 'r', 'u', 'd', 's')),
        (requested, sub) => {
          const requestedSet = new Set(requested)
          const granted = sub.filter((a) => requestedSet.has(a))
          const scopeRequest: ScopeRequest.ScopeRequest = {
            resources: [fhir('Observation', AccessRights.letters(requested))],
            flags: [],
          }
          const g = grant(
            granted.length > 0 ? [fhir('Observation', AccessRights.letters(granted))] : []
          )
          expect(ScopeRequest.isWithin(g, scopeRequest)).toBe(true)
        }
      )
    )
  })
})
