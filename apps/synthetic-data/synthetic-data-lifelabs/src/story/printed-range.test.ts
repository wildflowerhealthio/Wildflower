import { describe, expect, test } from 'vite-plus/test'

import * as PrintedRange from './printed-range.ts'

describe('PrintedRange.flagOf and print', () => {
  test.each([
    {
      range: PrintedRange.between('3.50', '5.00'),
      value: 3.49,
      flag: 'LO',
      printed: '3.50 - 5.00',
    },
    { range: PrintedRange.between('3.50', '5.00'), value: 3.5, flag: '', printed: '3.50 - 5.00' },
    { range: PrintedRange.between('3.50', '5.00'), value: 5, flag: '', printed: '3.50 - 5.00' },
    {
      range: PrintedRange.between('3.50', '5.00'),
      value: 5.01,
      flag: 'HI',
      printed: '3.50 - 5.00',
    },
    { range: PrintedRange.below('3.50'), value: 3.49, flag: '', printed: '<3.50' },
    { range: PrintedRange.below('3.50'), value: 3.5, flag: 'HI', printed: '<3.50' },
    { range: PrintedRange.atLeast('60'), value: 59, flag: 'LO', printed: '>=60' },
    { range: PrintedRange.atLeast('60'), value: 60, flag: '', printed: '>=60' },
  ] as const)('$value against $printed flags "$flag"', ({ range, value, flag, printed }) => {
    expect(PrintedRange.flagOf(value, range)).toBe(flag)
    expect(PrintedRange.print(range)).toBe(printed)
  })
})
