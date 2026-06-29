import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { AccessRights } from '../../index.ts'

const actionArb = fc.constantFrom<AccessRights.Action>('c', 'r', 'u', 'd', 's')
const lettersArb: fc.Arbitrary<AccessRights.AccessRights> = fc
  .uniqueArray(actionArb, { minLength: 1 })
  .map((l) => AccessRights.letters(l))
const wordArb: fc.Arbitrary<AccessRights.AccessRights> = fc.constantFrom(
  AccessRights.read,
  AccessRights.write,
  AccessRights.star
)
const accessArb: fc.Arbitrary<AccessRights.AccessRights> = fc.oneof(lettersArb, wordArb)

describe('sortActions', () => {
  test('canonicalizes order and dedupes', () => {
    expect(AccessRights.sortActions(['s', 'r', 'r', 'c'])).toEqual(['c', 'r', 's'])
  })
})

describe('v1 words ↔ CRUDS bits (mirrors Repr)', () => {
  test('read = r,s; write = c,u,d; star = all five', () => {
    expect(AccessRights.lettersOf(AccessRights.read)).toEqual(['r', 's'])
    expect(AccessRights.lettersOf(AccessRights.write)).toEqual(['c', 'u', 'd'])
    expect(AccessRights.lettersOf(AccessRights.star)).toEqual(['c', 'r', 'u', 'd', 's'])
  })

  test('read and write partition star', () => {
    const read = new Set(AccessRights.lettersOf(AccessRights.read))
    const write = new Set(AccessRights.lettersOf(AccessRights.write))
    expect([...read].some((a) => write.has(a))).toBe(false)
    expect(new Set([...read, ...write])).toEqual(new Set(AccessRights.lettersOf(AccessRights.star)))
  })
})

describe('serialize/parse round-trip', () => {
  test('canonical access round-trips through serialize → parse', () => {
    fc.assert(
      fc.property(accessArb, (access) => {
        expect(AccessRights.parse(AccessRights.serialize(access))).toEqual(access)
      })
    )
  })

  test('v1 words render verbatim; letter bags render canonically', () => {
    expect(AccessRights.serialize(AccessRights.read)).toBe('read')
    expect(AccessRights.serialize(AccessRights.star)).toBe('*')
    expect(AccessRights.serialize(AccessRights.letters(['s', 'r']))).toBe('rs')
  })

  test('parse rejects empty and stray-letter segments', () => {
    expect(AccessRights.parse('')).toBeNull()
    expect(AccessRights.parse('rx')).toBeNull()
  })
})

describe('subsetOf / has', () => {
  test('write ⊆ star, read ⊄ write', () => {
    expect(AccessRights.subsetOf(AccessRights.write, AccessRights.star)).toBe(true)
    expect(AccessRights.subsetOf(AccessRights.read, AccessRights.write)).toBe(false)
  })

  test('has matches the CRUDS bits regardless of form', () => {
    expect(AccessRights.has(AccessRights.read, 's')).toBe(true)
    expect(AccessRights.has(AccessRights.read, 'c')).toBe(false)
    expect(AccessRights.has(AccessRights.letters(['c', 'r']), 'r')).toBe(true)
  })
})
