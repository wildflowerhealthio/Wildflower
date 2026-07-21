import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { normalizeName, tokenize } from './normalize.ts'

describe('normalizeName', () => {
  test('lower-cases, strips marks and collapses whitespace', () => {
    expect(normalizeName('Abilify®')).toBe('abilify')
    expect(normalizeName('  Actonel   DR® ')).toBe('actonel dr')
  })

  test('strips HTML markup', () => {
    expect(normalizeName('<p><strong>Actonel DR®</strong></p>')).toBe('actonel dr')
    expect(normalizeName('Abilify<sup>®</sup>')).toBe('abilify')
  })

  test('drops strength / unit fragments', () => {
    expect(normalizeName('Abilify 5 mg tablet')).toBe('abilify tablet')
    expect(normalizeName('risedronate sodium 35mg')).toBe('risedronate sodium')
    expect(normalizeName('estradiol 0.5%')).toBe('estradiol')
  })

  test('folds diacritics', () => {
    expect(normalizeName('Créon')).toBe('creon')
  })

  test('empty / punctuation-only input normalizes to the empty string', () => {
    expect(normalizeName('')).toBe('')
    expect(normalizeName('   ')).toBe('')
    expect(normalizeName('®™ - / ')).toBe('')
  })

  test('is idempotent for all strings', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(normalizeName(normalizeName(input))).toBe(normalizeName(input))
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('output never contains uppercase, leading/trailing or doubled spaces', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const out = normalizeName(input)
        expect(out).toBe(out.toLowerCase())
        expect(out).toBe(out.trim())
        expect(out.includes('  ')).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('tokenize', () => {
  test('splits a normalized name into tokens', () => {
    expect(tokenize('Actonel DR® 35 mg')).toEqual(['actonel', 'dr'])
  })

  test('empty normalized input yields no tokens', () => {
    expect(tokenize('  ®  ')).toEqual([])
  })

  test('tokens equal the normalized name split on single spaces', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const normalized = normalizeName(input)
        const expected = normalized.length === 0 ? [] : normalized.split(' ')
        expect(tokenize(input)).toEqual(expected)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})
