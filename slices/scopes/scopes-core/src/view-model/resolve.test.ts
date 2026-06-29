import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { AccessRights, Bucket, Grant, GrantDraft, Resolve, Scope } from '../index.ts'

const b = Bucket.fhir('patient')

const fhir = (name: string, letters: AccessRights.Action[]): Scope.Scope => ({
  kind: 'fhir',
  context: 'patient',
  resource: name === '*' ? { kind: 'wildcard' } : { kind: 'known', name },
  access: AccessRights.letters(letters),
})

const wordFhir = (name: string, access: AccessRights.AccessRights): Scope.Scope => ({
  kind: 'fhir',
  context: 'patient',
  resource: { kind: 'known', name },
  access,
})

const lettersAt = (
  scopes: readonly Scope.Scope[],
  name: string
): readonly AccessRights.Action[] => {
  const row = GrantDraft.findResource(scopes, b, name)
  return row === undefined ? [] : AccessRights.lettersOf(row.access)
}

describe('Resolve.effectiveCell — wildcard union + lock (§3)', () => {
  test('a wildcard action grants + locks that cell on every specific row', () => {
    expect(Resolve.effectiveCell([fhir('*', ['r'])], b, 'Observation', 'r')).toEqual({
      granted: true,
      locked: true,
      source: 'wildcard',
    })
  })

  test('a specific action without a wildcard is granted but not locked', () => {
    expect(Resolve.effectiveCell([fhir('Observation', ['c'])], b, 'Observation', 'c')).toEqual({
      granted: true,
      locked: false,
      source: 'specific',
    })
  })

  test("the wildcard row's own cells are granted but NOT locked", () => {
    expect(Resolve.effectiveCell([fhir('*', ['r'])], b, '*', 'r')).toEqual({
      granted: true,
      locked: false,
      source: 'specific',
    })
  })

  test('a FHIR patient wildcard does not cover the Wildflower bucket', () => {
    const wf: Scope.Scope = {
      kind: 'wildflower',
      resource: { kind: 'wildcard' },
      access: AccessRights.letters(['r']),
    }
    expect(Resolve.effectiveCell([fhir('*', ['r']), wf], b, 'Observation', 'r').granted).toBe(true)
    // but a different context's wildcard wouldn't:
    const sysB = Bucket.fhir('system')
    expect(Resolve.effectiveCell([fhir('*', ['r'])], sysB, 'Observation', 'r').granted).toBe(false)
  })
})

describe('Resolve.toggleCell — the v2 mutation', () => {
  test('adds an action in canonical order', () => {
    expect(
      lettersAt(
        Resolve.toggleCell([fhir('Observation', ['s'])], b, 'Observation', 'c'),
        'Observation'
      )
    ).toEqual(['c', 's'])
  })

  test('removing the last action drops the specific row', () => {
    const next = Resolve.toggleCell([fhir('Observation', ['r'])], b, 'Observation', 'r')
    expect(next.some((s) => s.kind === 'fhir' && Scope.resourceName(s) === 'Observation')).toBe(
      false
    )
  })

  test('a wildcard-locked cell is a no-op', () => {
    const scopes = [fhir('*', ['r']), fhir('Observation', ['c'])]
    expect(Resolve.toggleCell(scopes, b, 'Observation', 'r')).toEqual(scopes)
  })

  test('toggling the same unlocked cell twice is identity on its letters', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom<AccessRights.Action>('c', 'r', 'u', 'd', 's'), {
          minLength: 1,
        }),
        fc.constantFrom<AccessRights.Action>('c', 'r', 'u', 'd', 's'),
        (start, action) => {
          const once = Resolve.toggleCell([fhir('Observation', start)], b, 'Observation', action)
          const twice = Resolve.toggleCell(once, b, 'Observation', action)
          expect(new Set(lettersAt(twice, 'Observation'))).toEqual(new Set(start))
        }
      )
    )
  })
})

describe('Resolve.toggleWordComponent — the v1 multiselect mutation', () => {
  test('adding Write to a Read scope makes it * (both)', () => {
    const next = Resolve.toggleWordComponent(
      [wordFhir('Observation', AccessRights.read)],
      b,
      'Observation',
      'write'
    )
    expect(GrantDraft.findResource(next, b, 'Observation')?.access).toEqual(AccessRights.star)
  })

  test('removing the only component drops the row', () => {
    const next = Resolve.toggleWordComponent(
      [wordFhir('Observation', AccessRights.read)],
      b,
      'Observation',
      'read'
    )
    expect(GrantDraft.findResource(next, b, 'Observation')).toBeUndefined()
  })

  test('toggling on an empty row creates that word', () => {
    const next = Resolve.toggleWordComponent([], b, 'Observation', 'write')
    expect(GrantDraft.findResource(next, b, 'Observation')?.access).toEqual(AccessRights.write)
  })

  test('removing Write from * leaves Read', () => {
    const next = Resolve.toggleWordComponent(
      [wordFhir('Observation', AccessRights.star)],
      b,
      'Observation',
      'write'
    )
    expect(GrantDraft.findResource(next, b, 'Observation')?.access).toEqual(AccessRights.read)
  })
})

describe('flags + removeResource', () => {
  test('setFlag / toggleFlag add and remove a Known scope', () => {
    const on = Resolve.setFlag([], 'openid', true)
    expect(Grant.hasKnown(on, 'openid')).toBe(true)
    expect(Grant.hasKnown(Resolve.toggleFlag(on, 'openid'), 'openid')).toBe(false)
  })

  test('removeResource drops only the named row', () => {
    const next = Resolve.removeResource(
      [fhir('Observation', ['r']), fhir('Condition', ['r'])],
      b,
      'Observation'
    )
    expect(next.map((s) => (s.kind === 'fhir' ? Scope.resourceName(s) : ''))).toEqual(['Condition'])
  })
})
