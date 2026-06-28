import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { lettersAccess, readAccess, starAccess } from './access.ts'
import {
  buildCell,
  buildWordCell,
  flagDisabled,
  flagRequired,
  isWithinEnvelope,
  resourceAccessForm,
} from './clamp.ts'
import type { Action, FhirResourceScope, Grant, RequestEnvelope, Scope } from './model.ts'
import { fhirBucket } from './scope.ts'

const b = fhirBucket('patient')
const grant = (scopes: Scope[]): Grant => ({ subject: 'jordan', scopes })

const fhir = (name: string, access = lettersAccess(['r'])): FhirResourceScope => ({
  kind: 'fhir',
  context: 'patient',
  resource: name === '*' ? { kind: 'wildcard' } : { kind: 'known', name },
  access,
})

describe('buildCell — clamp (§2) + wildcard lock (§3)', () => {
  const envelope: RequestEnvelope = {
    resources: [
      fhir('Observation', lettersAccess(['c', 'r', 's'])),
      { ...fhir('Condition', lettersAccess(['r'])), required: true },
    ],
    flags: [],
  }

  test('out-of-envelope action → disabled', () => {
    expect(buildCell(grant([]), envelope, b, 'Observation', 'd').state).toBe('disabled')
  })

  test('a resource not in the envelope → disabled', () => {
    expect(buildCell(grant([]), envelope, b, 'Goal', 'r').state).toBe('disabled')
  })

  test('requested + required → locked on', () => {
    expect(buildCell(grant([fhir('Condition')]), envelope, b, 'Condition', 'r')).toEqual({
      state: 'locked',
      lockReason: 'Required by the app',
    })
  })

  test('requested + optional → on when granted, off when not', () => {
    expect(buildCell(grant([fhir('Observation')]), envelope, b, 'Observation', 'r').state).toBe(
      'on'
    )
    expect(buildCell(grant([]), envelope, b, 'Observation', 'r').state).toBe('off')
  })

  test('open mode: wildcard-covered cell → locked', () => {
    expect(buildCell(grant([fhir('*')]), null, b, 'Observation', 'r')).toEqual({
      state: 'locked',
      lockReason: 'Granted by ✶ All record types',
    })
  })
})

describe('buildWordCell — v1 Read/Write clamp (§2)', () => {
  test('a component the request does not cover is disabled', () => {
    const envelope: RequestEnvelope = { resources: [fhir('Observation', readAccess)], flags: [] }
    expect(buildWordCell(grant([]), envelope, b, 'Observation', 'write').state).toBe('disabled')
    expect(buildWordCell(grant([]), envelope, b, 'Observation', 'read').state).toBe('off')
  })

  test('required ⇒ locked; open mode ⇒ on/off by the grant', () => {
    const envelope: RequestEnvelope = {
      resources: [{ ...fhir('Observation', starAccess), required: true }],
      flags: [],
    }
    expect(buildWordCell(grant([]), envelope, b, 'Observation', 'read').state).toBe('locked')
    expect(
      buildWordCell(grant([fhir('Observation', readAccess)]), null, b, 'Observation', 'read').state
    ).toBe('on')
    expect(
      buildWordCell(grant([fhir('Observation', readAccess)]), null, b, 'Observation', 'write').state
    ).toBe('off')
  })
})

describe('resourceAccessForm', () => {
  test('request mode follows the requested form (v1 stays v1)', () => {
    const envelope: RequestEnvelope = { resources: [fhir('Observation', starAccess)], flags: [] }
    expect(resourceAccessForm(grant([]), envelope, b, 'Observation')).toBe('word')
  })

  test('open mode follows the grant row, defaulting to letters', () => {
    expect(resourceAccessForm(grant([]), null, b, 'Observation')).toBe('letters')
    expect(
      resourceAccessForm(grant([fhir('Observation', readAccess)]), null, b, 'Observation')
    ).toBe('word')
  })
})

describe('flag clamping', () => {
  const envelope: RequestEnvelope = {
    resources: [],
    flags: [{ scope: 'openid', required: true }, { scope: 'profile' }],
  }

  test('required vs optional flags', () => {
    expect(flagRequired(envelope, 'openid')).toBe(true)
    expect(flagRequired(envelope, 'profile')).toBe(false)
  })

  test('not-requested flags are disabled; open mode never disables', () => {
    expect(flagDisabled(envelope, 'offline_access')).toBe(true)
    expect(flagDisabled(envelope, 'openid')).toBe(false)
    expect(flagDisabled(null, 'offline_access')).toBe(false)
  })
})

describe('isWithinEnvelope — granted ⊆ requested (§2)', () => {
  test('true in open mode', () => {
    expect(isWithinEnvelope(grant([fhir('Observation', starAccess)]), null)).toBe(true)
  })

  test('false when a granted action exceeds the request', () => {
    const envelope: RequestEnvelope = {
      resources: [fhir('Observation', lettersAccess(['r']))],
      flags: [],
    }
    expect(
      isWithinEnvelope(grant([fhir('Observation', lettersAccess(['r', 'c']))]), envelope)
    ).toBe(false)
  })

  test('any sub-grant of the requested letters stays within (property)', () => {
    const arb = fc.uniqueArray(fc.constantFrom<Action>('c', 'r', 'u', 'd', 's'), { minLength: 1 })
    fc.assert(
      fc.property(
        arb,
        fc.uniqueArray(fc.constantFrom<Action>('c', 'r', 'u', 'd', 's')),
        (requested, sub) => {
          const requestedSet = new Set(requested)
          const granted = sub.filter((a) => requestedSet.has(a))
          const envelope: RequestEnvelope = {
            resources: [fhir('Observation', lettersAccess(requested))],
            flags: [],
          }
          const g = grant(granted.length > 0 ? [fhir('Observation', lettersAccess(granted))] : [])
          expect(isWithinEnvelope(g, envelope)).toBe(true)
        }
      )
    )
  })
})
