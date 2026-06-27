import { describe, expect, test } from 'vite-plus/test'

import type { AppEntry } from '../../../queries.ts'
import { placementForMove } from './-reorder.ts'

const makeApp = (id: string): AppEntry => ({
  id,
  name: id,
  enabled: true,
  provenance: 'cloud',
  localOnly: false,
  smart: false,
  requiresTunnel: false,
})

const apps: readonly AppEntry[] = ['a', 'b', 'c', 'd'].map(makeApp)
const ids = (list: readonly AppEntry[]): readonly string[] => list.map((app) => app.id)

describe('placementForMove', () => {
  test('moving a tile down reorders the list and reports its new index', () => {
    const { order, move } = placementForMove(apps, 'a', 'c')
    // `a` lands where `c` was (index 2); `b`/`c` shift up to fill the gap.
    expect(ids(order)).toEqual(['b', 'c', 'a', 'd'])
    expect(move).toEqual({ id: 'a', position: 2 })
  })

  test('moving a tile up reorders the list and reports its new index', () => {
    const { order, move } = placementForMove(apps, 'd', 'b')
    expect(ids(order)).toEqual(['a', 'd', 'b', 'c'])
    expect(move).toEqual({ id: 'd', position: 1 })
  })

  test('a drop back onto the origin is a no-op (no write)', () => {
    const { order, move } = placementForMove(apps, 'b', 'b')
    expect(ids(order)).toEqual(ids(apps))
    expect(move).toBeNull()
  })

  test('an unknown active/over id is a no-op (no write)', () => {
    expect(placementForMove(apps, 'missing', 'b').move).toBeNull()
    expect(placementForMove(apps, 'a', 'missing').move).toBeNull()
  })

  test('the reported position points at the moved tile in the returned order', () => {
    // Invariant tying the two outputs together: `order[move.position]` is the
    // tile that moved. Guards against the index drifting out of step with the
    // array reorder.
    for (const [from, to] of [
      ['a', 'd'],
      ['d', 'a'],
      ['b', 'c'],
      ['c', 'a'],
    ] as const) {
      const { order, move } = placementForMove(apps, from, to)
      expect(move).not.toBeNull()
      if (move !== null) expect(order[move.position]?.id).toBe(move.id)
    }
  })
})
