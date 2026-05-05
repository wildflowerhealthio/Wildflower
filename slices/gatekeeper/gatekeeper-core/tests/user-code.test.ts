import * as fc from 'fast-check'
import { expect, test } from 'vite-plus/test'
import {
  ALPHABET,
  BLOCK_LENGTH,
  generateUserCode,
  isValidUserCode,
} from '../src/internal/user-code.ts'

test('generateUserCode produces a value matching the RFC 8628 alphabet', () => {
  const code = generateUserCode()
  expect(isValidUserCode(code)).toBe(true)
})

test('generateUserCode formats as XXXX-XXXX', () => {
  const code = generateUserCode()
  expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
})

test('generateUserCode never emits ambiguous characters', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 256 }), (count) => {
      for (let i = 0; i < count; i++) {
        const code = generateUserCode()
        for (const char of code) {
          if (char === '-') continue
          expect(ALPHABET).toContain(char)
        }
      }
    }),
    { numRuns: 8 }
  )
})

test('generateUserCode produces distinct codes across many draws', () => {
  // 1000 draws against ~1.6e10 keyspace — collisions should be vanishingly rare.
  const seen = new Set<string>()
  for (let i = 0; i < 1000; i++) {
    seen.add(generateUserCode())
  }
  expect(seen.size).toBe(1000)
})

test('isValidUserCode rejects codes that contain alphabet outsiders', () => {
  expect(isValidUserCode('AAAA-AAAA')).toBe(false) // A is not in alphabet
  expect(isValidUserCode('1234-5678')).toBe(false)
  expect(isValidUserCode('BCDF-GHJK')).toBe(true)
  expect(
    isValidUserCode(`${ALPHABET.slice(0, BLOCK_LENGTH)}-${ALPHABET.slice(0, BLOCK_LENGTH)}`)
  ).toBe(true)
})

test('isValidUserCode rejects malformed shapes', () => {
  expect(isValidUserCode('BCDFGHJK')).toBe(false) // missing dash
  expect(isValidUserCode('BCDF-GHJ')).toBe(false) // too short
  expect(isValidUserCode('BCDFG-GHJK')).toBe(false) // wrong block size
})
