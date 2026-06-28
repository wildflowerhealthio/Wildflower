import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import {
  accessFromComponents,
  accessHas,
  accessLetters,
  accessSubsetOf,
  coversComponent,
  lettersAccess,
  parseAccess,
  serializeAccess,
  sortActions,
  wordAccess,
  wordComponentsOf,
} from './access.ts'
import type { Access, AccessWord, Action } from './model.ts'

const actionArb = fc.constantFrom<Action>('c', 'r', 'u', 'd', 's')
const lettersArb: fc.Arbitrary<Access> = fc
  .uniqueArray(actionArb, { minLength: 1 })
  .map((letters) => lettersAccess(letters))
const wordArb: fc.Arbitrary<Access> = fc
  .constantFrom<AccessWord>('read', 'write', 'star')
  .map((w) => wordAccess(w))
const accessArb: fc.Arbitrary<Access> = fc.oneof(lettersArb, wordArb)

describe('sortActions', () => {
  test('canonicalizes order and dedupes', () => {
    expect(sortActions(['s', 'r', 'r', 'c'])).toEqual(['c', 'r', 's'])
  })

  test('output is always a subsequence of c r u d s', () => {
    fc.assert(
      fc.property(fc.array(actionArb), (actions) => {
        const sorted = sortActions(actions)
        const order: Action[] = ['c', 'r', 'u', 'd', 's']
        let cursor = -1
        for (const a of sorted) {
          const next = order.indexOf(a)
          expect(next).toBeGreaterThan(cursor)
          cursor = next
        }
      })
    )
  })
})

describe('v1 word ↔ CRUDS bits', () => {
  test('read = r,s; write = c,u,d; star = all five', () => {
    expect(accessLetters(wordAccess('read'))).toEqual(['r', 's'])
    expect(accessLetters(wordAccess('write'))).toEqual(['c', 'u', 'd'])
    expect(accessLetters(wordAccess('star'))).toEqual(['c', 'r', 'u', 'd', 's'])
  })

  test('read and write partition star', () => {
    const read = new Set(accessLetters(wordAccess('read')))
    const write = new Set(accessLetters(wordAccess('write')))
    const star = accessLetters(wordAccess('star'))
    expect([...read].some((a) => write.has(a))).toBe(false) // disjoint
    expect(new Set([...read, ...write])).toEqual(new Set(star)) // union = star
  })
})

describe('serialize/parse round-trip', () => {
  test('canonical access round-trips through serialize → parse', () => {
    fc.assert(
      fc.property(accessArb, (access) => {
        expect(parseAccess(serializeAccess(access))).toEqual(access)
      })
    )
  })

  test('v1 words render verbatim; letter bags render canonically', () => {
    expect(serializeAccess(wordAccess('read'))).toBe('read')
    expect(serializeAccess(wordAccess('star'))).toBe('*')
    expect(serializeAccess(lettersAccess(['s', 'r']))).toBe('rs')
  })

  test('parse rejects empty and stray-letter segments', () => {
    expect(parseAccess('')).toBeNull()
    expect(parseAccess('rx')).toBeNull()
  })
})

describe('accessSubsetOf / accessHas', () => {
  test('write ⊆ star, read ⊄ write', () => {
    expect(accessSubsetOf(wordAccess('write'), wordAccess('star'))).toBe(true)
    expect(accessSubsetOf(wordAccess('read'), wordAccess('write'))).toBe(false)
  })

  test('accessHas matches the CRUDS bits regardless of form', () => {
    expect(accessHas(wordAccess('read'), 's')).toBe(true)
    expect(accessHas(wordAccess('read'), 'c')).toBe(false)
    expect(accessHas(lettersAccess(['c', 'r']), 'r')).toBe(true)
  })
})

describe('v1 word components (Read / Write multiselect)', () => {
  test('coversComponent checks all of a component’s bits', () => {
    expect(coversComponent(wordAccess('read'), 'read')).toBe(true)
    expect(coversComponent(wordAccess('read'), 'write')).toBe(false)
    expect(coversComponent(wordAccess('star'), 'read')).toBe(true)
    expect(coversComponent(wordAccess('star'), 'write')).toBe(true)
    expect(coversComponent(null, 'read')).toBe(false)
    // a v2 letter bag that happens to hold r+s reads as the read component.
    expect(coversComponent(lettersAccess(['r', 's']), 'read')).toBe(true)
    expect(coversComponent(lettersAccess(['r']), 'read')).toBe(false) // missing s
  })

  test('wordComponentsOf reports the selected parts', () => {
    expect(wordComponentsOf(null)).toEqual({ read: false, write: false })
    expect(wordComponentsOf(wordAccess('read'))).toEqual({ read: true, write: false })
    expect(wordComponentsOf(wordAccess('write'))).toEqual({ read: false, write: true })
    expect(wordComponentsOf(wordAccess('star'))).toEqual({ read: true, write: true })
  })

  test('accessFromComponents: both ⇒ *, one ⇒ that word, neither ⇒ null', () => {
    expect(accessFromComponents({ read: true, write: true })).toEqual(wordAccess('star'))
    expect(accessFromComponents({ read: true, write: false })).toEqual(wordAccess('read'))
    expect(accessFromComponents({ read: false, write: true })).toEqual(wordAccess('write'))
    expect(accessFromComponents({ read: false, write: false })).toBeNull()
  })

  test('components round-trip through access and back', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (read, write) => {
        const access = accessFromComponents({ read, write })
        expect(wordComponentsOf(access)).toEqual({ read, write })
      })
    )
  })
})
