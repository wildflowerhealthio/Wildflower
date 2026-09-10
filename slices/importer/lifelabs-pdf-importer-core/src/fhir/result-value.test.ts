import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { parseResultValue } from './result-value.ts'

// `+ 0` folds a generated `-0` to `0`: the parser reads `-0` as zero.
const decimal = fc
  .double({ min: -1000, max: 10_000, noNaN: true, noDefaultInfinity: true })
  .map((n) => Number(n.toFixed(3)) + 0)

describe('parseResultValue', () => {
  it('property: a printed number, with or without a comparator, is a quantity', () => {
    fc.assert(
      fc.property(
        decimal,
        fc.constantFrom(undefined, '<', '<=', '>', '>='),
        fc.constantFrom('', ' '),
        (value, comparator, gap) => {
          const text = `${comparator ?? ''}${comparator === undefined ? '' : gap}${value}`

          expect(parseResultValue(text)).toEqual({ _tag: 'quantity', value, comparator })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('reads a thousands separator', () => {
    expect(parseResultValue('1,234')).toEqual({
      _tag: 'quantity',
      value: 1234,
      comparator: undefined,
    })
  })

  it('property: anything else is the trimmed text', () => {
    const notNumeric = fc
      .stringMatching(/^[A-Z][A-Z /:-]{0,12}$/)
      .filter((s) => !/^\d/.test(s.trim()))
    fc.assert(
      fc.property(notNumeric, (text) => {
        expect(parseResultValue(` ${text} `)).toEqual({ _tag: 'text', text: text.trim() })
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('keeps a date, a time, and an empty cell as text', () => {
    expect(parseResultValue('04-SEP-2024')).toEqual({ _tag: 'text', text: '04-SEP-2024' })
    expect(parseResultValue('08:11')).toEqual({ _tag: 'text', text: '08:11' })
    expect(parseResultValue('')).toEqual({ _tag: 'text', text: '' })
  })
})
