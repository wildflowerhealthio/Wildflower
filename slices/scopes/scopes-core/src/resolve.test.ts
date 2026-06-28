import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { accessLetters, lettersAccess, wordAccess } from './access.ts'
import type { Action, ScopePermission } from './model.ts'
import { effectiveCell, removePermission, toggleCell, toggleWordComponent } from './resolve.ts'

const perm = (resource: string, letters: Action[]): ScopePermission => ({
  context: 'patient',
  resource,
  access: lettersAccess(letters),
})

const lettersAt = (perms: readonly ScopePermission[], resource: string): readonly Action[] => {
  const row = perms.find((p) => p.resource === resource)
  return row === undefined ? [] : accessLetters(row.access)
}

describe('effectiveCell — wildcard union + lock (§3)', () => {
  test('a wildcard action grants + locks that cell on every specific row', () => {
    const perms = [perm('*', ['r'])]
    const cell = effectiveCell(perms, 'patient', 'Observation', 'r')
    expect(cell).toEqual({ granted: true, locked: true, source: 'wildcard' })
  })

  test('a specific action without a wildcard is granted but not locked', () => {
    const perms = [perm('Observation', ['c'])]
    const cell = effectiveCell(perms, 'patient', 'Observation', 'c')
    expect(cell).toEqual({ granted: true, locked: false, source: 'specific' })
  })

  test('an ungranted action is off and editable', () => {
    expect(effectiveCell([], 'patient', 'Observation', 'd')).toEqual({
      granted: false,
      locked: false,
      source: 'none',
    })
  })

  test('wildcard coverage is independent of context (wildflower has its own)', () => {
    const perms = [perm('*', ['r'])] // patient/*.r
    expect(effectiveCell(perms, 'wildflower', 'Grant', 'r').granted).toBe(false)
  })

  test("the wildcard row's own cells are granted but NOT locked (still editable)", () => {
    const perms = [perm('*', ['r'])]
    expect(effectiveCell(perms, 'patient', '*', 'r')).toEqual({
      granted: true,
      locked: false,
      source: 'specific',
    })
  })
})

describe('toggleCell — the v2 mutation', () => {
  test('adds an action in canonical order', () => {
    const next = toggleCell([perm('Observation', ['s'])], 'patient', 'Observation', 'c')
    expect(lettersAt(next, 'Observation')).toEqual(['c', 's'])
  })

  test('removing the last action drops the specific row', () => {
    const next = toggleCell([perm('Observation', ['r'])], 'patient', 'Observation', 'r')
    expect(next.some((p) => p.resource === 'Observation')).toBe(false)
  })

  test('a wildcard-locked cell is a no-op', () => {
    const perms = [perm('*', ['r']), perm('Observation', ['c'])]
    const next = toggleCell(perms, 'patient', 'Observation', 'r')
    expect(next).toEqual(perms) // unchanged — can't un-grant a wildcard-covered cell
  })

  test('does not mutate the input array', () => {
    const perms = [perm('Observation', ['r'])]
    toggleCell(perms, 'patient', 'Observation', 'c')
    expect(lettersAt(perms, 'Observation')).toEqual(['r'])
  })

  test('toggling the same unlocked cell twice is identity on its letters', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom<Action>('c', 'r', 'u', 'd', 's'), { minLength: 1 }),
        fc.constantFrom<Action>('c', 'r', 'u', 'd', 's'),
        (start, action) => {
          const once = toggleCell([perm('Observation', start)], 'patient', 'Observation', action)
          const twice = toggleCell(once, 'patient', 'Observation', action)
          expect(new Set(lettersAt(twice, 'Observation'))).toEqual(new Set(start))
        }
      )
    )
  })
})

describe('toggleWordComponent — the v1 multiselect mutation', () => {
  const wordPerm = (resource: string, word: 'read' | 'write' | 'star'): ScopePermission => ({
    context: 'patient',
    resource,
    access: wordAccess(word),
  })

  test('adding Write to a Read scope makes it * (both)', () => {
    const next = toggleWordComponent(
      [wordPerm('Observation', 'read')],
      'patient',
      'Observation',
      'write'
    )
    expect(next.find((p) => p.resource === 'Observation')?.access).toEqual(wordAccess('star'))
  })

  test('removing the only component drops the row', () => {
    const next = toggleWordComponent(
      [wordPerm('Observation', 'read')],
      'patient',
      'Observation',
      'read'
    )
    expect(next.some((p) => p.resource === 'Observation')).toBe(false)
  })

  test('toggling a component on an empty row creates that word', () => {
    const next = toggleWordComponent([], 'patient', 'Observation', 'write')
    expect(next.find((p) => p.resource === 'Observation')?.access).toEqual(wordAccess('write'))
  })

  test('removing Write from * leaves Read', () => {
    const next = toggleWordComponent(
      [wordPerm('Observation', 'star')],
      'patient',
      'Observation',
      'write'
    )
    expect(next.find((p) => p.resource === 'Observation')?.access).toEqual(wordAccess('read'))
  })
})

describe('removePermission', () => {
  test('drops only the named row', () => {
    const perms = [perm('Observation', ['r']), perm('Condition', ['r'])]
    const next = removePermission(perms, 'patient', 'Observation')
    expect(next.map((p) => p.resource)).toEqual(['Condition'])
  })
})
