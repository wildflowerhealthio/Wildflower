import { Arbitrary, FastCheck, Schema } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'

import type { TimelessDate } from './timeless-date-from-string.ts'
import { TimelessDateFromString } from './timeless-date-from-string.ts'

describe('TimelessDateFromString', () => {
  describe('decode', () => {
    it('should successfully decode a valid YYYY-MM-DD date string', () => {
      const result = Schema.decodeUnknownSync(TimelessDateFromString)('2025-12-29')

      expect(result).toBe('2025-12-29')
      expect(typeof result).toBe('string')
    })

    it('should successfully decode a leap day in a leap year', () => {
      const result = Schema.decodeUnknownSync(TimelessDateFromString)('2024-02-29')

      expect(result).toBe('2024-02-29')
    })

    it('should fail to decode an invalid date string (not YYYY-MM-DD format)', () => {
      expect(() => {
        Schema.decodeUnknownSync(TimelessDateFromString)('29/12/2025')
      }).toThrow(/Expected a string matching the pattern/)
    })

    it('should fail to decode a date-time string with non-midnight time', () => {
      expect(() => {
        Schema.decodeUnknownSync(TimelessDateFromString)('2025-12-29T14:30:00.000Z')
      }).toThrow(/Expected a string matching the pattern/)
    })

    it('should fail to decode a non-string value', () => {
      expect(() => {
        Schema.decodeUnknownSync(TimelessDateFromString)(12345)
      }).toThrow()
    })

    it('should fail to decode an impossible date (Feb 30)', () => {
      expect(() => {
        Schema.decodeUnknownSync(TimelessDateFromString)('2024-02-30')
      }).toThrow(/Expected a valid calendar date/)
    })

    it('should fail to decode an impossible date (Feb 29 in a non-leap year)', () => {
      expect(() => {
        Schema.decodeUnknownSync(TimelessDateFromString)('2023-02-29')
      }).toThrow(/Expected a valid calendar date/)
    })

    it('should fail to decode month 13', () => {
      expect(() => {
        Schema.decodeUnknownSync(TimelessDateFromString)('2024-13-01')
      }).toThrow(/Expected a valid calendar date/)
    })

    it('should fail to decode day 32', () => {
      expect(() => {
        Schema.decodeUnknownSync(TimelessDateFromString)('2024-01-32')
      }).toThrow(/Expected a valid calendar date/)
    })

    it('should fail to decode month 00', () => {
      expect(() => {
        Schema.decodeUnknownSync(TimelessDateFromString)('2024-00-15')
      }).toThrow(/Expected a valid calendar date/)
    })
  })

  describe('encode', () => {
    it('should successfully encode a branded TimelessDate string', () => {
      const decoded = Schema.decodeUnknownSync(TimelessDateFromString)('2025-12-29')
      const result = Schema.encodeSync(TimelessDateFromString)(decoded)

      expect(result).toBe('2025-12-29')
    })
  })

  describe('brand', () => {
    it('should produce a branded type that is distinct from a plain string', () => {
      const decoded = Schema.decodeUnknownSync(TimelessDateFromString)('2025-06-15')

      expectTypeOf(decoded).toEqualTypeOf<TimelessDate>()
      expect(decoded).toBe('2025-06-15')
    })

    it('should prevent plain strings from being assigned to TimelessDate at compile time', () => {
      expectTypeOf<string>().not.toExtend<TimelessDate>()
    })
  })

  describe('arbitrary', () => {
    const samples = FastCheck.sample(Arbitrary.make(TimelessDateFromString), {
      numRuns: 2000,
      seed: 1,
    })

    it('generates dates that decode, within years 1900–2100', () => {
      for (const sample of samples) {
        expect(Schema.decodeUnknownSync(TimelessDateFromString)(sample)).toBe(sample)
        expect(sample >= '1900-01-01' && sample <= '2100-12-31').toBe(true)
      }
    })

    it('spreads across the 1900–2100 range rather than clustering near one era', () => {
      const years = new Set(samples.map((sample) => sample.slice(0, 4)))
      expect(years.size).toBeGreaterThan(150)
    })
  })
})
