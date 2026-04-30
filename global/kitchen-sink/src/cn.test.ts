import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { cn } from './cn.ts'

describe('cn', () => {
  it('joins string arguments with single spaces', () => {
    // Arrange
    // Act
    const result = cn('a', 'b', 'c')

    // Assert
    expect(result).toBe('a b c')
  })

  it('drops falsy values (undefined, null, false, empty string)', () => {
    // Arrange
    // Act
    const result = cn('a', undefined, null, false, '', 'b')

    // Assert
    expect(result).toBe('a b')
  })

  it('includes object keys whose values are truthy', () => {
    // Arrange
    // Act
    const result = cn('base', { active: true, disabled: false })

    // Assert
    expect(result).toBe('base active')
  })

  it('returns an empty string when given only falsy inputs', () => {
    // Arrange
    // Act
    const result = cn(undefined, null, false, '')

    // Assert
    expect(result).toBe('')
  })

  it('returns an empty string when called with no arguments', () => {
    // Arrange
    // Act
    const result = cn()

    // Assert
    expect(result).toBe('')
  })

  it('preserves caller-provided class order', () => {
    // Arrange
    // Act
    const result = cn('z', 'a', 'm')

    // Assert
    expect(result).toBe('z a m')
  })

  it('emits object keys in their iteration order', () => {
    // Arrange
    const flags = { first: true, second: true, third: true }

    // Act
    const result = cn(flags)

    // Assert
    expect(result).toBe('first second third')
  })

  it('should never produce leading, trailing, or repeated whitespace', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-zA-Z][\w-]*$/)), (classes) => {
        // Arrange
        // Act
        const result = cn(...classes)

        // Assert
        expect(result).not.toMatch(/^\s/)
        expect(result).not.toMatch(/\s$/)
        expect(result).not.toMatch(/\s\s/)
      })
    )
  })

  it('should always include every truthy string argument as a token in order', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-zA-Z][\w-]*$/)), (classes) => {
        // Arrange
        // Act
        const tokens = cn(...classes)
          .split(' ')
          .filter((t) => t.length > 0)

        // Assert
        expect(tokens).toEqual(classes.filter((c) => c.length > 0))
      })
    )
  })
})
