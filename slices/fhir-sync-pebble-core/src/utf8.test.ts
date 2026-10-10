import { utf8Bytes as textEncoderBytes } from '@wildflowerhealthio/kitchen-sink'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { truncateUtf8, utf8Bytes } from './utf8.ts'

/**
 * Strings that reach every UTF-8 length and the surrogate edge cases: ASCII,
 * two- and three-byte characters, astral ones (surrogate pairs) and lone
 * surrogates, which `fc.string` alone rarely draws.
 */
const textArbitrary = fc
  .array(
    fc.oneof(
      fc.constantFrom('a', 'é', '€', '日', '😀', '𝄞', '\ud800', '\udc00', '\u0000'),
      fc.string({ unit: 'grapheme', maxLength: 3 }),
      fc.string({ unit: 'binary', maxLength: 3 })
    ),
    { maxLength: 30 }
  )
  .map((pieces) => pieces.join(''))

describe('utf8Bytes', () => {
  it('should encode as TextEncoder does, lone surrogates included', () => {
    fc.assert(
      fc.property(textArbitrary, (text) => {
        expect(utf8Bytes(text)).toEqual([...textEncoderBytes(text)])
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it.each([
    ['ASCII', 'Ada', [0x41, 0x64, 0x61]],
    ['a two-byte character', 'é', [0xc3, 0xa9]],
    ['a three-byte character', '€', [0xe2, 0x82, 0xac]],
    ['a surrogate pair', '😀', [0xf0, 0x9f, 0x98, 0x80]],
    ['a lone surrogate, as U+FFFD', '\ud800', [0xef, 0xbf, 0xbd]],
  ])('should encode %s', (_, text, bytes) => {
    expect(utf8Bytes(text)).toEqual(bytes)
  })
})

describe('truncateUtf8', () => {
  it('should keep the longest whole-code-point prefix that fits', () => {
    fc.assert(
      fc.property(textArbitrary, fc.nat({ max: 80 }), (text, maxBytes) => {
        // Act
        const truncated = truncateUtf8(text, maxBytes)

        // Assert: a prefix, within the budget, cut between code points, and one
        // more code point would not fit.
        expect(text.startsWith(truncated)).toBe(true)
        expect(utf8Bytes(truncated).length).toBeLessThanOrEqual(maxBytes)
        expect(utf8Bytes(text).slice(0, utf8Bytes(truncated).length)).toEqual(utf8Bytes(truncated))
        if (truncated.length < text.length) {
          const nextCodePoint = String.fromCodePoint(text.codePointAt(truncated.length) ?? 0)
          const withNext = text.slice(0, truncated.length + nextCodePoint.length)
          expect(utf8Bytes(withNext).length).toBeGreaterThan(maxBytes)
        }
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should leave text that fits as it is', () => {
    fc.assert(
      fc.property(textArbitrary, (text) => {
        expect(truncateUtf8(text, utf8Bytes(text).length)).toBe(text)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it.each([
    ['a two-byte character', 'aé', 2, 'a'],
    ['a three-byte character', 'ab€', 4, 'ab'],
    ['a surrogate pair', 'abc😀', 6, 'abc'],
    ['a surrogate pair at the budget', 'abc😀', 7, 'abc😀'],
  ])('should drop %s that would cross the budget whole', (_, text, maxBytes, truncated) => {
    expect(truncateUtf8(text, maxBytes)).toBe(truncated)
  })
})
