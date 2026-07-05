import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Scope } from '../../../index.ts'

const Cruds = Scope.Permission.Cruds
const permissionArb = fc
  .uniqueArray(fc.constantFrom<Scope.Permission.Cruds.Interaction>('c', 'r', 'u', 'd', 's'), {
    minLength: 1,
  })
  .map((l) => new Cruds(l))

describe('CrudsPermission — parse / serialize (v2 letter bags)', () => {
  test('serialize renders canonical c r u d s order; empty → null', () => {
    expect(new Cruds(['s', 'r']).serialize()).toBe('rs')
    expect(new Cruds(['s', 'd', 'c', 'r', 'u']).serialize()).toBe('cruds')
    expect(Cruds.empty.serialize()).toBeNull()
  })

  test('toArray canonicalizes and dedupes', () => {
    expect(new Cruds(['s', 'r', 'r', 'c']).toArray()).toEqual(['c', 'r', 's'])
  })

  test('parse accepts letter bags; rejects v1 words and stray letters', () => {
    expect(Cruds.parse('rs')).toEqual(new Cruds(['r', 's']))
    expect(Cruds.parse('read')).toBeNull()
    expect(Cruds.parse('write')).toBeNull()
    expect(Cruds.parse('*')).toBeNull()
    expect(Cruds.parse('rx')).toBeNull()
    expect(Cruds.parse('')).toBeNull()
  })

  test('letter bags round-trip through serialize → parse (property)', () => {
    fc.assert(
      fc.property(permissionArb, (permission) => {
        const serialized = permission.serialize()
        if (serialized === null) throw new Error('serialize returned null')
        expect(Cruds.parse(serialized)).toEqual(permission)
      })
    )
  })

  test('label reads as a sentence', () => {
    expect(new Cruds(['c', 'r', 's']).label()).toBe('Create, Read, and Search')
    expect(new Cruds(['r']).label()).toBe('Read')
  })
})
