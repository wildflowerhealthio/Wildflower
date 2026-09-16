import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Permission from './index.ts'

const Cruds = Permission.Cruds
const ReadWrite = Permission.ReadWrite

describe('Permission — shared editing surface (cruds)', () => {
  test('items are the five cruds cells in canonical order', () => {
    expect(Cruds.empty.items.map((i) => i.id)).toEqual(['c', 'r', 'u', 'd', 's'])
    expect(Cruds.empty.items.map((i) => i.name)).toEqual([
      'Create',
      'Read',
      'Update',
      'Delete',
      'Search',
    ])
  })

  test('has / isEmpty', () => {
    expect(new Cruds(['r']).has('r')).toBe(true)
    expect(new Cruds(['r']).has('c')).toBe(false)
    expect(Cruds.empty.isEmpty()).toBe(true)
    expect(new Cruds(['r']).isEmpty()).toBe(false)
  })

  test('toggle adds and removes, returning a new same-style permission', () => {
    expect(Cruds.empty.toggle('c')).toEqual(new Cruds(['c']))
    expect(new Cruds(['r']).toggle('c')).toEqual(new Cruds(['c', 'r']))
    expect(new Cruds(['r']).toggle('r')).toEqual(Cruds.empty)
  })

  test('subsetOf tests same-style membership', () => {
    expect(new Cruds(['r']).subsetOf(new Cruds(['r', 's']))).toBe(true)
    expect(new Cruds(['c']).subsetOf(new Cruds(['r', 's']))).toBe(false)
  })

  test('subtractCovered trims a partial overlap, drops a full one, keeps a disjoint one', () => {
    expect(new Cruds(['c', 'r']).subtractCovered(new Cruds(['r']))).toEqual({
      kind: 'remainder',
      value: new Cruds(['c']),
    })
    expect(new Cruds(['r']).subtractCovered(new Cruds(['r', 's']))).toEqual({ kind: 'covered' })
    expect(new Cruds(['c']).subtractCovered(new Cruds(['r']))).toEqual({ kind: 'whole' })
  })

  test('toggling the same cell twice is identity (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom<Permission.Cruds.Interaction>('c', 'r', 'u', 'd', 's')),
        fc.constantFrom<Permission.Cruds.Interaction>('c', 'r', 'u', 'd', 's'),
        (start, id) => {
          const base = new Cruds(start)
          expect(base.toggle(id).toggle(id)).toEqual(base)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('Permission — shared editing surface (readWrite)', () => {
  test('items are the two Read/Write words', () => {
    expect(ReadWrite.empty.items.map((i) => i.id)).toEqual(['read', 'write'])
  })

  test('toggle composes the words (both ⇒ *, neither ⇒ empty)', () => {
    expect(ReadWrite.empty.toggle('write')).toEqual(ReadWrite.write)
    expect(ReadWrite.read.toggle('write')).toEqual(ReadWrite.star)
    expect(ReadWrite.read.toggle('read')).toEqual(ReadWrite.empty)
    expect(ReadWrite.star.toggle('write')).toEqual(ReadWrite.read)
  })

  test('subtractCovered works within the readWrite style (no cruds conversion)', () => {
    expect(ReadWrite.star.subtractCovered(ReadWrite.read)).toEqual({
      kind: 'remainder',
      value: ReadWrite.write,
    })
    expect(ReadWrite.read.subtractCovered(ReadWrite.star)).toEqual({ kind: 'covered' })
  })
})
