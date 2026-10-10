import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as ColourSlots from './colour-slots.ts'
import * as ValueAxis from './value-axis.ts'

const RUNS = numRunsFor({ base: 200 })

/** A selection: distinct ids, at most the cap. */
const selection = fc.uniqueArray(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g'), {
  maxLength: ValueAxis.CAP,
})

describe('ColourSlots.assign', () => {
  test('a first draw colours the selection in order', () => {
    fc.assert(
      fc.property(selection, (ids) => {
        const slots = ColourSlots.assign(new Map(), ids)
        expect([...slots.entries()]).toEqual(ids.map((id, index) => [id, index]))
      }),
      { numRuns: RUNS }
    )
  })

  test('survivors keep their colour; everyone gets a distinct in-palette colour', () => {
    fc.assert(
      fc.property(selection, selection, (before, after) => {
        const previous = ColourSlots.assign(new Map(), before)
        const next = ColourSlots.assign(previous, after)
        expect([...next.keys()].toSorted()).toEqual([...after].toSorted())
        for (const id of after) {
          const kept = previous.get(id)
          if (kept !== undefined) expect(next.get(id)).toBe(kept)
        }
        const colours = [...next.values()]
        expect(new Set(colours).size).toBe(colours.length)
        for (const colour of colours) {
          expect(colour).toBeGreaterThanOrEqual(0)
          expect(colour).toBeLessThan(ValueAxis.CAP)
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('removing an earlier series does not repaint the rest', () => {
    const previous = ColourSlots.assign(new Map(), ['a', 'b', 'c'])
    const next = ColourSlots.assign(previous, ['b', 'c'])
    expect(next.get('b')).toBe(1)
    expect(next.get('c')).toBe(2)
    expect(ColourSlots.assign(next, ['b', 'c', 'd']).get('d')).toBe(0)
  })

  test('an unchanged selection returns the same assignment', () => {
    fc.assert(
      fc.property(selection, (ids) => {
        const previous = ColourSlots.assign(new Map(), ids)
        expect(ColourSlots.assign(previous, ids.toReversed())).toBe(previous)
      }),
      { numRuns: RUNS }
    )
  })

  test('throws past the cap rather than cycling the palette', () => {
    const ids = Array.from({ length: ValueAxis.CAP + 1 }, (_, index) => `s${index}`)
    expect(() => ColourSlots.assign(new Map(), ids)).toThrow()
  })
})
