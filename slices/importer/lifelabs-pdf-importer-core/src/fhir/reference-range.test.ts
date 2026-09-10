import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { parseReferenceRange } from './reference-range.ts'

const decimal = fc
  .double({ min: 0, max: 10_000, noNaN: true, noDefaultInfinity: true })
  .map((n) => Number(n.toFixed(2)))

const spaces = fc.constantFrom('', ' ', '  ')

describe('parseReferenceRange', () => {
  it('property: `low - high` with any spacing reads to both bounds and keeps the text', () => {
    fc.assert(
      fc.property(decimal, decimal, spaces, spaces, (low, high, before, after) => {
        const text = `${low}${before}-${after}${high}`

        expect(parseReferenceRange(text)).toEqual({ low, high, text })
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('property: a one-sided range names only the bound it prints', () => {
    fc.assert(
      fc.property(
        decimal,
        spaces,
        fc.constantFrom('<', '<=', '>', '>=', '=>'),
        (bound, gap, comparator) => {
          const text = `${comparator}${gap}${bound}`

          const range = parseReferenceRange(text)

          expect(range.text).toBe(text)
          if (comparator.startsWith('<'))
            expect(range).toMatchObject({ low: undefined, high: bound })
          else expect(range).toMatchObject({ low: bound, high: undefined })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('reads the shapes the report prints', () => {
    expect(parseReferenceRange('120- 160')).toEqual({ low: 120, high: 160, text: '120- 160' })
    expect(parseReferenceRange('< 1.8')).toEqual({ low: undefined, high: 1.8, text: '< 1.8' })
    expect(parseReferenceRange('>=1.30')).toEqual({ low: 1.3, high: undefined, text: '>=1.30' })
  })

  it('keeps a range with no bounds as text alone', () => {
    for (const text of ['See below', 'NEGATIVE', 'NONE/YELLOW', '', 'a - b']) {
      expect(parseReferenceRange(text)).toEqual({ low: undefined, high: undefined, text })
    }
  })
})
