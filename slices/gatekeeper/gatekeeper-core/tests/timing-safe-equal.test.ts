import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { expect, test } from 'vite-plus/test'
import { timingSafeEqual } from '../src/internal/timing-safe-equal.ts'

test('timingSafeEqual returns true for identical strings', () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      expect(timingSafeEqual(s, s)).toBe(true)
    }),
    { numRuns: numRunsFor(100) }
  )
})

test('timingSafeEqual returns false for different strings', () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), (a, b) => {
      // Skip the trivial case where the random arbitraries collide.
      if (a === b) return
      expect(timingSafeEqual(a, b)).toBe(false)
    }),
    { numRuns: numRunsFor(100) }
  )
})

test('timingSafeEqual matches strict equality', () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), (a, b) => {
      expect(timingSafeEqual(a, b)).toBe(a === b)
    }),
    { numRuns: numRunsFor(200) }
  )
})

test('timingSafeEqual handles empty strings', () => {
  expect(timingSafeEqual('', '')).toBe(true)
  expect(timingSafeEqual('', 'a')).toBe(false)
  expect(timingSafeEqual('a', '')).toBe(false)
})

test('timingSafeEqual handles unicode correctly', () => {
  expect(timingSafeEqual('héllo', 'héllo')).toBe(true)
  expect(timingSafeEqual('héllo', 'hello')).toBe(false)
  expect(timingSafeEqual('🌻', '🌻')).toBe(true)
  expect(timingSafeEqual('🌻', '🌷')).toBe(false)
})
