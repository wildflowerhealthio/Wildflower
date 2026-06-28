import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { accessLetters, lettersAccess, readAccess, starAccess } from './access.ts'
import type { Access, Action, ContextLevel, Scope } from './model.ts'
import {
  effectiveCell,
  removeResource,
  setFlag,
  toggleCell,
  toggleFlag,
  toggleWordComponent,
} from './resolve.ts'
import { fhirBucket, findResource, hasFlag, resourceScopeName } from './scope.ts'

const b = fhirBucket('patient')

const fhir = (name: string, letters: Action[]): Scope => ({
  kind: 'fhir',
  context: 'patient',
  resource: name === '*' ? { kind: 'wildcard' } : { kind: 'known', name },
  access: lettersAccess(letters),
})

const wordFhir = (name: string, access: Access): Scope => ({
  kind: 'fhir',
  context: 'patient',
  resource: { kind: 'known', name },
  access,
})

const lettersAt = (scopes: readonly Scope[], name: string): readonly Action[] => {
  const row = findResource(scopes, b, name)
  return row === undefined ? [] : accessLetters(row.access)
}

describe('effectiveCell — wildcard union + lock (§3)', () => {
  test('a wildcard action grants + locks that cell on every specific row', () => {
    expect(effectiveCell([fhir('*', ['r'])], b, 'Observation', 'r')).toEqual({
      granted: true,
      locked: true,
      source: 'wildcard',
    })
  })

  test('a specific action without a wildcard is granted but not locked', () => {
    expect(effectiveCell([fhir('Observation', ['c'])], b, 'Observation', 'c')).toEqual({
      granted: true,
      locked: false,
      source: 'specific',
    })
  })

  test("the wildcard row's own cells are granted but NOT locked", () => {
    expect(effectiveCell([fhir('*', ['r'])], b, '*', 'r')).toEqual({
      granted: true,
      locked: false,
      source: 'specific',
    })
  })

  test('a FHIR patient wildcard does not cover the Wildflower bucket', () => {
    const wf: Scope = {
      kind: 'wildflower',
      resource: { kind: 'wildcard' },
      access: lettersAccess(['r']),
    }
    expect(effectiveCell([fhir('*', ['r']), wf], b, 'Observation', 'r').granted).toBe(true)
    // but a different context's wildcard wouldn't:
    const sysB = fhirBucket('system' satisfies ContextLevel)
    expect(effectiveCell([fhir('*', ['r'])], sysB, 'Observation', 'r').granted).toBe(false)
  })
})

describe('toggleCell — the v2 mutation', () => {
  test('adds an action in canonical order', () => {
    expect(
      lettersAt(toggleCell([fhir('Observation', ['s'])], b, 'Observation', 'c'), 'Observation')
    ).toEqual(['c', 's'])
  })

  test('removing the last action drops the specific row', () => {
    const next = toggleCell([fhir('Observation', ['r'])], b, 'Observation', 'r')
    expect(next.some((s) => s.kind === 'fhir' && resourceScopeName(s) === 'Observation')).toBe(
      false
    )
  })

  test('a wildcard-locked cell is a no-op', () => {
    const scopes = [fhir('*', ['r']), fhir('Observation', ['c'])]
    expect(toggleCell(scopes, b, 'Observation', 'r')).toEqual(scopes)
  })

  test('toggling the same unlocked cell twice is identity on its letters', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom<Action>('c', 'r', 'u', 'd', 's'), { minLength: 1 }),
        fc.constantFrom<Action>('c', 'r', 'u', 'd', 's'),
        (start, action) => {
          const once = toggleCell([fhir('Observation', start)], b, 'Observation', action)
          const twice = toggleCell(once, b, 'Observation', action)
          expect(new Set(lettersAt(twice, 'Observation'))).toEqual(new Set(start))
        }
      )
    )
  })
})

describe('toggleWordComponent — the v1 multiselect mutation', () => {
  test('adding Write to a Read scope makes it * (both)', () => {
    const next = toggleWordComponent(
      [wordFhir('Observation', readAccess)],
      b,
      'Observation',
      'write'
    )
    expect(findResource(next, b, 'Observation')?.access).toEqual(starAccess)
  })

  test('removing the only component drops the row', () => {
    const next = toggleWordComponent(
      [wordFhir('Observation', readAccess)],
      b,
      'Observation',
      'read'
    )
    expect(findResource(next, b, 'Observation')).toBeUndefined()
  })

  test('toggling on an empty row creates that word', () => {
    const next = toggleWordComponent([], b, 'Observation', 'write')
    expect(findResource(next, b, 'Observation')?.access).toEqual({ kind: 'write' })
  })

  test('removing Write from * leaves Read', () => {
    const next = toggleWordComponent(
      [wordFhir('Observation', starAccess)],
      b,
      'Observation',
      'write'
    )
    expect(findResource(next, b, 'Observation')?.access).toEqual(readAccess)
  })
})

describe('flags + removeResource', () => {
  test('setFlag / toggleFlag add and remove a Known scope', () => {
    const on = setFlag([], 'openid', true)
    expect(hasFlag(on, 'openid')).toBe(true)
    expect(hasFlag(toggleFlag(on, 'openid'), 'openid')).toBe(false)
  })

  test('removeResource drops only the named row', () => {
    const next = removeResource(
      [fhir('Observation', ['r']), fhir('Condition', ['r'])],
      b,
      'Observation'
    )
    expect(next.map((s) => (s.kind === 'fhir' ? resourceScopeName(s) : ''))).toEqual(['Condition'])
  })
})
