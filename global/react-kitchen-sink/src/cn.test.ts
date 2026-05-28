import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { cn } from './cn.ts'

describe('cn', () => {
  it('joins string arguments with single spaces', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c')
  })

  it('drops falsy values (undefined, null, false, empty string)', () => {
    expect(cn('a', undefined, null, false, '', 'b')).toBe('a b')
  })

  it('includes object keys whose values are truthy', () => {
    expect(cn('base', { active: true, disabled: false })).toBe('base active')
  })

  it('returns an empty string when given only falsy inputs', () => {
    expect(cn(undefined, null, false, '')).toBe('')
  })

  it('returns an empty string when called with no arguments', () => {
    expect(cn()).toBe('')
  })

  it('preserves caller-provided class order', () => {
    expect(cn('z', 'a', 'm')).toBe('z a m')
  })

  it('emits object keys in their iteration order', () => {
    const flags = { first: true, second: true, third: true }
    expect(cn(flags)).toBe('first second third')
  })

  it('should never produce leading, trailing, or repeated whitespace', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-zA-Z][\w-]*$/)), (classes) => {
        const result = cn(...classes)
        expect(result).not.toMatch(/^\s/)
        expect(result).not.toMatch(/\s$/)
        expect(result).not.toMatch(/\s\s/)
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  it('should always include every truthy string argument as a token in order', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-zA-Z][\w-]*$/)), (classes) => {
        const tokens = cn(...classes)
          .split(' ')
          .filter((t) => t.length > 0)
        expect(tokens).toEqual(classes.filter((c) => c.length > 0))
      }),
      { numRuns: numRunsFor(100) }
    )
  })
})
