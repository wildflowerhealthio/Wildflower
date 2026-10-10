import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { detectShape, generateFake, type LeafShape } from './shapes.ts'

const seed = fc.uint8Array({ minLength: 32, maxLength: 32 })

/**
 * One or more values per shape class, written out rather than generated: this is
 * the table that says what each class *means*, so it has to be readable and it
 * has to be able to fail when a regex is loosened.
 */
const examples: Readonly<Record<LeafShape, readonly string[]>> = {
  iso8601: ['2024-03-11', '2024-03-11T09:41:02Z', '2024-03-11T09:41:02.123+05:30'],
  dotNetDate: ['/Date(1779297900000-0400)/', '/Date(1710150062000)/', '/Date(-86400000+0000)/'],
  jwt: [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  ],
  uuid: ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', '3F2504E0-4F89-41D3-9A0C-0305E82C3301'],
  email: ['patient.zero@example.org'],
  currency: ['$1,299.00', '-42.50'],
  postalCode: ['02139', '02139-4307', 'K1A 0B1'],
  phone: ['+16135550142', '(613) 555-0142', '613-555-0142'],
  epochMillis: ['1710150062000'],
  // Five digits are read as a postal code and thirteen as epoch millis, so a
  // plain numeric id is anything else — see the disjointness test below.
  numericId: ['104329', '987654321012'],
  alphanumericId: ['MRN-88213', 'active', 'a1b2c3'],
  freeText: ['Complete blood count', 'Dr. Ada Lovelace, MD'],
}

describe('detectShape', () => {
  test('sorts each written example into its own class', () => {
    for (const [shape, values] of Object.entries(examples)) {
      for (const value of values) {
        expect({ value, shape: detectShape(value) }).toEqual({ value, shape })
      }
    }
  })

  test('overlapping numeric readings resolve to the narrower class', () => {
    // Deliberate: the classes are disjoint by construction, and where two
    // readings are equally plausible the narrower one wins. Every one of these
    // produces the same digit count, so nothing downstream depends on which.
    expect(detectShape('02139')).toBe('postalCode')
    expect(detectShape('1710150062000')).toBe('epochMillis')
    expect(detectShape('104329')).toBe('numericId')
  })

  test('an unspaced Canadian postal code falls through to alphanumericId', () => {
    // `K1A0B1` cannot be told apart from any other six-character alternating
    // alphanumeric, and both classes generate the same character-class-preserving
    // fake, so the looser reading is the honest one.
    expect(detectShape('K1A 0B1')).toBe('postalCode')
    expect(detectShape('K1A0B1')).toBe('alphanumericId')
  })
})

describe('generateFake', () => {
  test('property: the fake of every example is of the same shape class', () => {
    fc.assert(
      fc.property(fc.constantFrom(...Object.values(examples).flat()), seed, (original, bytes) => {
        expect(detectShape(generateFake(detectShape(original), original, bytes))).toBe(
          detectShape(original)
        )
      }),
      { numRuns: numRunsFor({ base: 300 }) }
    )
  })

  test('property: the same seed always gives the same fake, a different one rarely does', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.values(examples).flat()),
        seed,
        seed,
        (original, first, second) => {
          const shape = detectShape(original)
          expect(generateFake(shape, original, first)).toBe(generateFake(shape, original, first))
          fc.pre(first.some((byte, index) => byte !== second[index]))
          // Not an absolute guarantee — a short shape has few possible fakes —
          // but for the long examples in the table it holds.
          if (original.length >= 12) {
            expect(generateFake(shape, original, first)).not.toBe(
              generateFake(shape, original, second)
            )
          }
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('property: a fake preserves length and per-character class for the mapped shapes', () => {
    const mapped = [
      ...examples.phone,
      ...examples.postalCode,
      ...examples.alphanumericId,
      ...examples.freeText,
    ]
    fc.assert(
      fc.property(fc.constantFrom(...mapped), seed, (original, bytes) => {
        const fake = generateFake(detectShape(original), original, bytes)
        expect(fake).toHaveLength(original.length)
        for (const [index, char] of Array.from(original).entries()) {
          const replacement = fake[index] ?? ''
          if (/\d/.test(char)) expect(replacement).toMatch(/\d/)
          else if (/[a-z]/.test(char)) expect(replacement).toMatch(/[a-z]/)
          else if (/[A-Z]/.test(char)) expect(replacement).toMatch(/[A-Z]/)
          else expect(replacement).toBe(char)
        }
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('an ISO 8601 fake keeps its precision and timezone designator, and moves the instant', () => {
    const fake = generateFake(
      'iso8601',
      '2024-03-11T09:41:02.123+05:30',
      new Uint8Array(32).fill(7)
    )
    expect(fake).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+05:30$/)
    expect(fake).not.toBe('2024-03-11T09:41:02.123+05:30')
  })

  test('a .NET date fake keeps the literal and the offset suffix, and moves the millis', () => {
    const bytes = new Uint8Array(32).fill(9)
    const withOffset = generateFake('dotNetDate', '/Date(1779297900000-0400)/', bytes)
    expect(withOffset).toMatch(/^\/Date\(\d{13}-0400\)\/$/)
    expect(withOffset).not.toBe('/Date(1779297900000-0400)/')
    expect(generateFake('dotNetDate', '/Date(1779297900000)/', bytes)).toMatch(
      /^\/Date\(\d{13}\)\/$/
    )
  })

  test('property: a .NET date fake still matches the consumer regex the shape exists for', () => {
    // The pattern `lifelabs-source` reads `collectionDate` with; a free-text
    // fake (`/Uwbx(…)/`) does not match it.
    const consumerPattern = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//
    const token = fc.record({
      millis: fc.integer({ min: -2_000_000_000_000, max: 2_000_000_000_000 }),
      offset: fc.option(fc.stringMatching(/^[+-]\d{4}$/), { nil: '' }),
    })
    fc.assert(
      fc.property(token, seed, ({ millis, offset }, bytes) => {
        const original = `/Date(${millis}${offset})/`
        expect(detectShape(original)).toBe('dotNetDate')
        const fake = generateFake('dotNetDate', original, bytes)
        expect(detectShape(fake)).toBe('dotNetDate')
        expect(fake).toMatch(consumerPattern)
        expect(fake.endsWith(`${offset})/`)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('a date-only ISO 8601 fake stays date-only', () => {
    expect(generateFake('iso8601', '2024-03-11', new Uint8Array(32).fill(3))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/
    )
  })

  test('a UUID fake is v4-shaped and keeps the original hex case', () => {
    const bytes = new Uint8Array(32).fill(11)
    expect(generateFake('uuid', '3f2504e0-4f89-41d3-9a0c-0305e82c3301', bytes)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(generateFake('uuid', '3F2504E0-4F89-41D3-9A0C-0305E82C3301', bytes)).toMatch(
      /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/
    )
  })

  test('an email fake keeps the top-level domain and drops everything to its left', () => {
    const fake = generateFake('email', 'patient.zero@mayoclinic.org', new Uint8Array(32).fill(5))
    expect(fake.endsWith('.org')).toBe(true)
    expect(fake).not.toContain('patient')
    expect(fake).not.toContain('mayoclinic')
  })
})
