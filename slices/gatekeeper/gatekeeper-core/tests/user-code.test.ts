import { Effect, Layer } from 'effect'
import * as fc from 'fast-check'
import { expect, test } from 'vite-plus/test'
import {
  ALPHABET,
  BLOCK_COUNT,
  BLOCK_LENGTH,
  CryptoRandomByte,
  CryptoRandomByteLayerLive,
  generateUserCode,
  isValidUserCode,
} from '../src/internal/user-code.ts'

const runUserCode = (): string =>
  Effect.runSync(Effect.provide(generateUserCode, CryptoRandomByteLayerLive))

const REJECTION_LIMIT = 256 - (256 % ALPHABET.length)

const stubBytes = (queue: ReadonlyArray<number>): Layer.Layer<CryptoRandomByte> => {
  let i = 0
  return Layer.succeed(CryptoRandomByte, {
    next: Effect.sync(() => {
      const b = queue[i++]
      if (b === undefined) throw new Error('stub byte queue exhausted')
      return b
    }),
  })
}

const runWithStub = (queue: ReadonlyArray<number>): string =>
  Effect.runSync(Effect.provide(generateUserCode, stubBytes(queue)))

test('generateUserCode produces a value matching the RFC 8628 alphabet', () => {
  expect(isValidUserCode(runUserCode())).toBe(true)
})

test('generateUserCode formats as XXXX-XXXX', () => {
  expect(runUserCode()).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
})

test('generateUserCode never emits ambiguous characters', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 256 }), (count) => {
      for (let i = 0; i < count; i++) {
        const code = runUserCode()
        for (const char of code) {
          if (char === '-') continue
          expect(ALPHABET).toContain(char)
        }
      }
    }),
    { numRuns: 8 }
  )
})

test('generateUserCode draws every alphabet character given enough samples', () => {
  // 1000 codes × 8 chars per code = 8000 alphabet draws. Birthday-style
  // expectation: every one of the 20 alphabet characters should appear
  // at least once, which is deterministically near-certain (probability
  // ~1 - 20·(19/20)^8000 ≈ 1) and doesn't depend on RNG outputs being
  // distinct (which can't be asserted without flake risk).
  const seenChars = new Set<string>()
  for (let i = 0; i < 1000; i++) {
    for (const ch of runUserCode()) {
      if (ch !== '-') seenChars.add(ch)
    }
  }
  expect(seenChars.size).toBe(ALPHABET.length)
})

test('generateUserCode maps accepted bytes to alphabet via modulo', () => {
  // Bytes 0..3 in each block → ALPHABET[0..3] in each block.
  const code = runWithStub([0, 1, 2, 3, 0, 1, 2, 3])
  const block = ALPHABET.slice(0, BLOCK_LENGTH)
  expect(code).toBe(`${block}-${block}`)
})

test('generateUserCode rejects bytes ≥ REJECTION_LIMIT and resamples', () => {
  // First two bytes are out-of-range and must be skipped; the third
  // (0) is accepted and yields ALPHABET[0]. Repeat across the full code.
  const queue: number[] = []
  for (let i = 0; i < BLOCK_COUNT * BLOCK_LENGTH; i++) {
    queue.push(REJECTION_LIMIT, REJECTION_LIMIT + 7, 0)
  }
  const code = runWithStub(queue)
  const block = ALPHABET[0]?.repeat(BLOCK_LENGTH)
  expect(code).toBe(`${block}-${block}`)
})

test('generateUserCode pulls exactly BLOCK_COUNT × BLOCK_LENGTH bytes when none are rejected', () => {
  let pulls = 0
  const layer = Layer.succeed(CryptoRandomByte, {
    next: Effect.sync(() => {
      pulls++
      return 0
    }),
  })
  Effect.runSync(Effect.provide(generateUserCode, layer))
  expect(pulls).toBe(BLOCK_COUNT * BLOCK_LENGTH)
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
