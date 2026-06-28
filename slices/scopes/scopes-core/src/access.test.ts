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
  readAccess,
  serializeAccess,
  sortActions,
  starAccess,
  wordComponentsOf,
  writeAccess,
} from './access.ts'
import type { Access, Action } from './model.ts'

const actionArb = fc.constantFrom<Action>('c', 'r', 'u', 'd', 's')
const lettersArb: fc.Arbitrary<Access> = fc
  .uniqueArray(actionArb, { minLength: 1 })
  .map((letters) => lettersAccess(letters))
const wordArb: fc.Arbitrary<Access> = fc.constantFrom(readAccess, writeAccess, starAccess)
const accessArb: fc.Arbitrary<Access> = fc.oneof(lettersArb, wordArb)

describe('sortActions', () => {
  test('canonicalizes order and dedupes', () => {
    expect(sortActions(['s', 'r', 'r', 'c'])).toEqual(['c', 'r', 's'])
  })
})

describe('v1 words ↔ CRUDS bits (mirrors Repr)', () => {
  test('read = r,s; write = c,u,d; star = all five', () => {
    expect(accessLetters(readAccess)).toEqual(['r', 's'])
    expect(accessLetters(writeAccess)).toEqual(['c', 'u', 'd'])
    expect(accessLetters(starAccess)).toEqual(['c', 'r', 'u', 'd', 's'])
  })

  test('read and write partition star', () => {
    const read = new Set(accessLetters(readAccess))
    const write = new Set(accessLetters(writeAccess))
    expect([...read].some((a) => write.has(a))).toBe(false)
    expect(new Set([...read, ...write])).toEqual(new Set(accessLetters(starAccess)))
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
    expect(serializeAccess(readAccess)).toBe('read')
    expect(serializeAccess(starAccess)).toBe('*')
    expect(serializeAccess(lettersAccess(['s', 'r']))).toBe('rs')
  })

  test('parse rejects empty and stray-letter segments', () => {
    expect(parseAccess('')).toBeNull()
    expect(parseAccess('rx')).toBeNull()
  })
})

describe('accessSubsetOf / accessHas', () => {
  test('write ⊆ star, read ⊄ write', () => {
    expect(accessSubsetOf(writeAccess, starAccess)).toBe(true)
    expect(accessSubsetOf(readAccess, writeAccess)).toBe(false)
  })

  test('accessHas matches the CRUDS bits regardless of form', () => {
    expect(accessHas(readAccess, 's')).toBe(true)
    expect(accessHas(readAccess, 'c')).toBe(false)
    expect(accessHas(lettersAccess(['c', 'r']), 'r')).toBe(true)
  })
})

describe('v1 word components (Read / Write multiselect)', () => {
  test('coversComponent checks all of a component’s bits', () => {
    expect(coversComponent(readAccess, 'read')).toBe(true)
    expect(coversComponent(readAccess, 'write')).toBe(false)
    expect(coversComponent(starAccess, 'read')).toBe(true)
    expect(coversComponent(starAccess, 'write')).toBe(true)
    expect(coversComponent(null, 'read')).toBe(false)
    expect(coversComponent(lettersAccess(['r', 's']), 'read')).toBe(true)
    expect(coversComponent(lettersAccess(['r']), 'read')).toBe(false) // missing s
  })

  test('accessFromComponents: both ⇒ star, one ⇒ that word, neither ⇒ null', () => {
    expect(accessFromComponents({ read: true, write: true })).toEqual(starAccess)
    expect(accessFromComponents({ read: true, write: false })).toEqual(readAccess)
    expect(accessFromComponents({ read: false, write: true })).toEqual(writeAccess)
    expect(accessFromComponents({ read: false, write: false })).toBeNull()
  })

  test('components round-trip through access and back', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (read, write) => {
        expect(wordComponentsOf(accessFromComponents({ read, write }))).toEqual({ read, write })
      })
    )
  })
})
