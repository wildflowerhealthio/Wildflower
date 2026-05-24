import { describe, expect, it } from 'vite-plus/test'

import { unwrapCause } from './unwrap-cause.ts'

describe('unwrapCause', () => {
  it('returns a non-object value as-is', () => {
    expect(unwrapCause('boom')).toBe('boom')
    expect(unwrapCause(42)).toBe(42)
    expect(unwrapCause(null)).toBe(null)
    expect(unwrapCause(undefined)).toBe(undefined)
  })

  it('returns an Error without a cause as-is', () => {
    const err = new Error('boom')
    expect(unwrapCause(err)).toBe(err)
  })

  it('returns the cause when an Error has one', () => {
    const inner = new Error('inner')
    const outer = new Error('outer', { cause: inner })
    expect(unwrapCause(outer)).toBe(inner)
  })
})
