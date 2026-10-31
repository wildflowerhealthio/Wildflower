import { describe, expect, it } from 'vite-plus/test'

import { ucumCodeFor } from './units.ts'

describe('ucumCodeFor', () => {
  it('maps a listed display spelling to its UCUM code', () => {
    expect(ucumCodeFor('g/L')).toBe('g/L')
    expect(ucumCodeFor('x E9/L')).toBe('10*9/L')
    expect(ucumCodeFor('mL/min/1.73m2')).toBe('mL/min/{1.73_m2}')
    expect(ucumCodeFor('IU/L')).toBe('[IU]/L')
  })

  it('returns undefined for an unlisted spelling — never guess a code', () => {
    expect(ucumCodeFor('made-up unit')).toBeUndefined()
    expect(ucumCodeFor('')).toBeUndefined()
  })

  it('trims whitespace so a stray space does not lose a known unit', () => {
    expect(ucumCodeFor('  g/L ')).toBe('g/L')
    expect(ucumCodeFor('\tx E9/L\n')).toBe('10*9/L')
  })
})
