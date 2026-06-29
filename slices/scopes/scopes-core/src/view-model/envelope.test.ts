import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import type { Fhir, GrantDraft, Scope } from '../index.ts'
import { AccessRights, Bucket, Envelope } from '../index.ts'

const b = Bucket.fhir('patient')
const grant = (scopes: Scope.Scope[]): GrantDraft.GrantDraft => ({ subject: 'jordan', scopes })

const fhir = (name: string, access = AccessRights.letters(['r'])): Fhir.FhirResourceScope => ({
  kind: 'fhir',
  context: 'patient',
  resource: name === '*' ? { kind: 'wildcard' } : { kind: 'known', name },
  access,
})

describe('Envelope.buildCell — clamp (§2) + wildcard lock (§3)', () => {
  const envelope: Envelope.Envelope = {
    resources: [
      fhir('Observation', AccessRights.letters(['c', 'r', 's'])),
      { ...fhir('Condition', AccessRights.letters(['r'])), required: true },
    ],
    flags: [],
  }

  test('out-of-envelope action → disabled', () => {
    expect(Envelope.buildCell(grant([]), envelope, b, 'Observation', 'd').state).toBe('disabled')
  })

  test('a resource not in the envelope → disabled', () => {
    expect(Envelope.buildCell(grant([]), envelope, b, 'Goal', 'r').state).toBe('disabled')
  })

  test('requested + required → locked on', () => {
    expect(Envelope.buildCell(grant([fhir('Condition')]), envelope, b, 'Condition', 'r')).toEqual({
      state: 'locked',
      lockReason: 'Required by the app',
    })
  })

  test('requested + optional → on when granted, off when not', () => {
    expect(
      Envelope.buildCell(grant([fhir('Observation')]), envelope, b, 'Observation', 'r').state
    ).toBe('on')
    expect(Envelope.buildCell(grant([]), envelope, b, 'Observation', 'r').state).toBe('off')
  })

  test('open mode: wildcard-covered cell → locked', () => {
    expect(Envelope.buildCell(grant([fhir('*')]), null, b, 'Observation', 'r')).toEqual({
      state: 'locked',
      lockReason: 'Granted by ✶ All record types',
    })
  })
})

describe('Envelope.buildWordCell — v1 Read/Write clamp (§2)', () => {
  test('a component the request does not cover is disabled', () => {
    const envelope: Envelope.Envelope = {
      resources: [fhir('Observation', AccessRights.read)],
      flags: [],
    }
    expect(Envelope.buildWordCell(grant([]), envelope, b, 'Observation', 'write').state).toBe(
      'disabled'
    )
    expect(Envelope.buildWordCell(grant([]), envelope, b, 'Observation', 'read').state).toBe('off')
  })

  test('required ⇒ locked; open mode ⇒ on/off by the grant', () => {
    const envelope: Envelope.Envelope = {
      resources: [{ ...fhir('Observation', AccessRights.star), required: true }],
      flags: [],
    }
    expect(Envelope.buildWordCell(grant([]), envelope, b, 'Observation', 'read').state).toBe(
      'locked'
    )
    expect(
      Envelope.buildWordCell(
        grant([fhir('Observation', AccessRights.read)]),
        null,
        b,
        'Observation',
        'read'
      ).state
    ).toBe('on')
    expect(
      Envelope.buildWordCell(
        grant([fhir('Observation', AccessRights.read)]),
        null,
        b,
        'Observation',
        'write'
      ).state
    ).toBe('off')
  })
})

describe('Envelope.accessForm', () => {
  test('request mode follows the requested form (v1 stays v1)', () => {
    const envelope: Envelope.Envelope = {
      resources: [fhir('Observation', AccessRights.star)],
      flags: [],
    }
    expect(Envelope.accessForm(grant([]), envelope, b, 'Observation')).toBe('word')
  })

  test('open mode follows the grant row, defaulting to letters', () => {
    expect(Envelope.accessForm(grant([]), null, b, 'Observation')).toBe('letters')
    expect(
      Envelope.accessForm(grant([fhir('Observation', AccessRights.read)]), null, b, 'Observation')
    ).toBe('word')
  })
})

describe('flag clamping', () => {
  const envelope: Envelope.Envelope = {
    resources: [],
    flags: [{ scope: 'openid', required: true }, { scope: 'profile' }],
  }

  test('required vs optional flags', () => {
    expect(Envelope.flagRequired(envelope, 'openid')).toBe(true)
    expect(Envelope.flagRequired(envelope, 'profile')).toBe(false)
  })

  test('not-requested flags are disabled; open mode never disables', () => {
    expect(Envelope.flagDisabled(envelope, 'offline_access')).toBe(true)
    expect(Envelope.flagDisabled(envelope, 'openid')).toBe(false)
    expect(Envelope.flagDisabled(null, 'offline_access')).toBe(false)
  })
})

describe('Envelope.isWithin — granted ⊆ requested (§2)', () => {
  test('true in open mode', () => {
    expect(Envelope.isWithin(grant([fhir('Observation', AccessRights.star)]), null)).toBe(true)
  })

  test('false when a granted action exceeds the request', () => {
    const envelope: Envelope.Envelope = {
      resources: [fhir('Observation', AccessRights.letters(['r']))],
      flags: [],
    }
    expect(
      Envelope.isWithin(grant([fhir('Observation', AccessRights.letters(['r', 'c']))]), envelope)
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
          const envelope: Envelope.Envelope = {
            resources: [fhir('Observation', AccessRights.letters(requested))],
            flags: [],
          }
          const g = grant(
            granted.length > 0 ? [fhir('Observation', AccessRights.letters(granted))] : []
          )
          expect(Envelope.isWithin(g, envelope)).toBe(true)
        }
      )
    )
  })
})
