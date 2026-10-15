import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { keyedText, matchKey } from './match-key.ts'

describe('matchKey', () => {
  it('should fold case', () => {
    expect(matchKey('John SMITH')).toBe(matchKey('john smith'))
  })

  it('should key composed and decomposed accents alike', () => {
    expect(matchKey('José')).toBe(matchKey('José'))
  })

  it('should key Turkish dotted and dotless i as i', () => {
    expect(matchKey('İ')).toBe('i')
    expect(matchKey('ı')).toBe('i')
  })

  it('should key both sigmas alike', () => {
    expect(matchKey('ς')).toBe(matchKey('Σ'))
    expect(matchKey('σ')).toBe(matchKey('Σ'))
  })

  it('should key compatibility variants as their plain letters', () => {
    expect(matchKey('ＪＯＨＮ')).toBe('john')
    expect(matchKey('Ⓙⓞⓗⓝ')).toBe('john')
    expect(matchKey('ﬁ')).toBe('fi')
    expect(matchKey('ſmith')).toBe('smith')
  })

  it('should key a combining mark as the empty string', () => {
    expect(matchKey('́')).toBe('')
  })

  it('should always be idempotent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (input) => {
        expect(matchKey(matchKey(input))).toBe(matchKey(input))
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('keyedText', () => {
  it('should map each key unit back to the code point that produced it', () => {
    // Arrange & Act
    const { key, starts, ends } = keyedText('aﬁb')

    // Assert
    expect(key).toBe('afib')
    expect(starts).toEqual([0, 1, 1, 2])
    expect(ends).toEqual([1, 2, 2, 3])
  })

  it('should extend a letter span over the combining marks after it', () => {
    // Arrange & Act
    const { key, starts, ends } = keyedText('é̂x')

    // Assert
    expect(key).toBe('ex')
    expect(starts).toEqual([0, 3])
    expect(ends).toEqual([3, 4])
  })

  it('should always key the text to its matchKey', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (input) => {
        expect(keyedText(input).key).toBe(matchKey(input))
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})
