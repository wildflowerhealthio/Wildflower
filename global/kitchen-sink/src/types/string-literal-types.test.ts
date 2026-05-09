import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  endsWithAlphanumericCharacter,
  endsWithDigit,
  isDigit,
} from './string-literal-types.ts'

describe('isDigit', () => {
  it('returns true iff the input matches /^[0-9]$/', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.char()), (s) => {
        const expected = /^[0-9]$/.test(s)
        expect(isDigit(s)).toBe(expected)
      })
    )
  })

  it('returns true for every single-digit literal', () => {
    for (const digit of '0123456789') {
      expect(isDigit(digit)).toBe(true)
    }
  })

  it('returns false for the empty string and multi-character inputs', () => {
    expect(isDigit('')).toBe(false)
    expect(isDigit('00')).toBe(false)
    expect(isDigit('1a')).toBe(false)
  })
})

describe('endsWithDigit', () => {
  it('returns true iff the last character is a digit', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const last = s.at(-1)
        const expected = last !== undefined && '0123456789'.includes(last)
        expect(endsWithDigit(s)).toBe(expected)
      })
    )
  })

  it('returns false for the empty string', () => {
    expect(endsWithDigit('')).toBe(false)
  })
})

describe('endsWithAlphanumericCharacter', () => {
  it('returns true iff the last character matches /[a-zA-Z0-9]/', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const expected = /[a-zA-Z0-9]$/.test(s)
        expect(endsWithAlphanumericCharacter(s)).toBe(expected)
      })
    )
  })

  it('returns false for the empty string', () => {
    expect(endsWithAlphanumericCharacter('')).toBe(false)
  })
})
