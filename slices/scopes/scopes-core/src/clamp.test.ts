import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { lettersAccess, wordAccess } from './access.ts'
import {
  buildCell,
  buildWordCell,
  flagDisabled,
  flagRequired,
  isWithinEnvelope,
  resourceAccessForm,
} from './clamp.ts'
import type { Action, Grant, RequestEnvelope, ScopePermission } from './model.ts'

const grant = (permissions: ScopePermission[], flags: Grant['flags'] = []): Grant => ({
  subject: 'jordan',
  permissions,
  flags,
})

describe('buildCell — clamp (§2) + wildcard lock (§3)', () => {
  const envelope: RequestEnvelope = {
    permissions: [
      {
        context: 'patient',
        resource: 'Observation',
        access: lettersAccess(['c', 'r', 's']),
        required: false,
      },
      { context: 'patient', resource: 'Condition', access: lettersAccess(['r']), required: true },
    ],
    flags: [],
  }

  test('out-of-envelope action → disabled', () => {
    // Destroy was never requested on Observation.
    expect(buildCell(grant([]), envelope, 'patient', 'Observation', 'd')).toEqual({
      state: 'disabled',
      lockReason: 'Not requested by the app',
    })
  })

  test('a resource not in the envelope → disabled', () => {
    expect(buildCell(grant([]), envelope, 'patient', 'Goal', 'r').state).toBe('disabled')
  })

  test('requested + required → locked on', () => {
    const g = grant([{ context: 'patient', resource: 'Condition', access: lettersAccess(['r']) }])
    expect(buildCell(g, envelope, 'patient', 'Condition', 'r')).toEqual({
      state: 'locked',
      lockReason: 'Required by the app',
    })
  })

  test('requested + optional → on when granted, off when not', () => {
    const granted = grant([
      { context: 'patient', resource: 'Observation', access: lettersAccess(['r']) },
    ])
    expect(buildCell(granted, envelope, 'patient', 'Observation', 'r').state).toBe('on')
    expect(buildCell(grant([]), envelope, 'patient', 'Observation', 'r').state).toBe('off')
  })

  test('open mode: wildcard-covered cell → locked', () => {
    const g = grant([{ context: 'patient', resource: '*', access: lettersAccess(['r']) }])
    expect(buildCell(g, null, 'patient', 'Observation', 'r')).toEqual({
      state: 'locked',
      lockReason: 'Granted by ✶ All record types',
    })
  })

  test('open mode: plain editable cell → on/off', () => {
    expect(buildCell(grant([]), null, 'patient', 'Observation', 'c').state).toBe('off')
  })
})

describe('buildWordCell — v1 Read/Write clamp (§2)', () => {
  test('a component the request does not cover is disabled', () => {
    // requested `.read` → Write was not requested.
    const envelope: RequestEnvelope = {
      permissions: [{ context: 'patient', resource: 'Observation', access: wordAccess('read') }],
      flags: [],
    }
    expect(buildWordCell(grant([]), envelope, 'patient', 'Observation', 'write').state).toBe(
      'disabled'
    )
    expect(buildWordCell(grant([]), envelope, 'patient', 'Observation', 'read').state).toBe('off')
  })

  test('required ⇒ locked; open mode ⇒ on/off by what the grant selects', () => {
    const required: RequestEnvelope = {
      permissions: [
        { context: 'patient', resource: 'Observation', access: wordAccess('star'), required: true },
      ],
      flags: [],
    }
    expect(buildWordCell(grant([]), required, 'patient', 'Observation', 'read').state).toBe(
      'locked'
    )

    const g = grant([{ context: 'patient', resource: 'Observation', access: wordAccess('read') }])
    expect(buildWordCell(g, null, 'patient', 'Observation', 'read').state).toBe('on')
    expect(buildWordCell(g, null, 'patient', 'Observation', 'write').state).toBe('off')
  })
})

describe('resourceAccessForm', () => {
  test('request mode follows the requested form (v1 stays v1)', () => {
    const envelope: RequestEnvelope = {
      permissions: [{ context: 'patient', resource: 'Observation', access: wordAccess('star') }],
      flags: [],
    }
    expect(resourceAccessForm(grant([]), envelope, 'patient', 'Observation')).toBe('word')
  })

  test('open mode follows the grant row, defaulting to letters', () => {
    expect(resourceAccessForm(grant([]), null, 'patient', 'Observation')).toBe('letters')
    const g = grant([{ context: 'patient', resource: 'Observation', access: wordAccess('read') }])
    expect(resourceAccessForm(g, null, 'patient', 'Observation')).toBe('word')
  })
})

describe('flag clamping', () => {
  const envelope: RequestEnvelope = {
    permissions: [],
    flags: [{ scope: 'openid', required: true }, { scope: 'profile' }],
  }

  test('a requested-required flag is required; a requested-optional flag is not', () => {
    expect(flagRequired(envelope, 'openid')).toBe(true)
    expect(flagRequired(envelope, 'profile')).toBe(false)
  })

  test('a flag not in the envelope is disabled; open mode never disables', () => {
    expect(flagDisabled(envelope, 'offline_access')).toBe(true)
    expect(flagDisabled(envelope, 'openid')).toBe(false)
    expect(flagDisabled(null, 'offline_access')).toBe(false)
  })
})

describe('isWithinEnvelope — granted ⊆ requested (§2)', () => {
  test('true in open mode', () => {
    expect(
      isWithinEnvelope(
        grant([{ context: 'patient', resource: 'X', access: wordAccess('star') }]),
        null
      )
    ).toBe(true)
  })

  test('false when a granted action exceeds the request', () => {
    const envelope: RequestEnvelope = {
      permissions: [{ context: 'patient', resource: 'Observation', access: lettersAccess(['r']) }],
      flags: [],
    }
    const g = grant([
      { context: 'patient', resource: 'Observation', access: lettersAccess(['r', 'c']) },
    ])
    expect(isWithinEnvelope(g, envelope)).toBe(false)
  })

  test('any sub-grant of the requested letters stays within the envelope (property)', () => {
    const requestedArb = fc.uniqueArray(fc.constantFrom<Action>('c', 'r', 'u', 'd', 's'), {
      minLength: 1,
    })
    fc.assert(
      fc.property(
        requestedArb,
        fc.uniqueArray(fc.constantFrom<Action>('c', 'r', 'u', 'd', 's')),
        (requested, sub) => {
          const requestedSet = new Set(requested)
          const granted = sub.filter((a) => requestedSet.has(a)) // any subset of what's requested
          const envelope: RequestEnvelope = {
            permissions: [
              { context: 'patient', resource: 'Observation', access: lettersAccess(requested) },
            ],
            flags: [],
          }
          const g = grant(
            granted.length > 0
              ? [{ context: 'patient', resource: 'Observation', access: lettersAccess(granted) }]
              : []
          )
          expect(isWithinEnvelope(g, envelope)).toBe(true)
        }
      )
    )
  })
})
