import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  ddinterDrugUrl,
  type DdinterFile,
  decodeDdinterFile,
  isNonDrugName,
  pairKey,
  severityBetween,
} from './ddinter.ts'
import { SeverityCode, severityFromCode } from './severity.ts'

describe('decodeDdinterFile', () => {
  it('should decode the drug table and expose severities symmetrically', () => {
    // Arrange
    const file = fileWith([
      [0, 1, 0],
      [1, 2, 1],
    ])

    // Act
    const catalog = decodeDdinterFile(file)

    // Assert
    expect(catalog.drugs.map((drug) => drug.name)).toEqual(['Warfarin', 'Ibuprofen', 'Caffeine'])
    expect(catalog.drugs[0]?.id).toBe('DDInter1')
    expect(severityBetween(catalog, 0, 1)).toBe('major')
    expect(severityBetween(catalog, 1, 0)).toBe('major')
    expect(severityBetween(catalog, 0, 2)).toBeNull()
  })

  it('should never report an interaction of a drug with itself', () => {
    const catalog = decodeDdinterFile(fileWith([[0, 1, 0]]))
    expect(severityBetween(catalog, 1, 1)).toBeNull()
  })

  it('should flag curated non-drug names', () => {
    const catalog = decodeDdinterFile(fileWith([]))
    expect(catalog.drugs.map((drug) => drug.nonDrug)).toEqual([false, false, true])
  })

  it('should reject an out-of-range pair index', () => {
    expect(() => decodeDdinterFile(fileWith([[0, 3, 0]]))).toThrow(/out of range/)
  })

  it('should reject an unordered or self pair', () => {
    expect(() => decodeDdinterFile(fileWith([[2, 1, 0]]))).toThrow(/unordered/)
    expect(() => decodeDdinterFile(fileWith([[1, 1, 0]]))).toThrow(/unordered/)
  })

  it('should reject a pair listed twice', () => {
    expect(() =>
      decodeDdinterFile(
        fileWith([
          [0, 1, 0],
          [0, 1, 2],
        ])
      )
    ).toThrow(/more than once/)
  })

  it('should reject a file that is not the compact shape', () => {
    expect(() => decodeDdinterFile({ drugs: [], pairs: [] })).toThrow()
    expect(() => decodeDdinterFile(null)).toThrow()
  })

  it('should always expose exactly the listed pairs, order-insensitively', () => {
    fc.assert(
      fc.property(fileArb, (file) => {
        // Act
        const catalog = decodeDdinterFile(file)

        // Assert
        expect(catalog.pairs.size).toBe(file.pairs.length)
        expect(catalog.drugs).toHaveLength(file.drugs.length)
        for (const [a, b, code] of file.pairs) {
          expect(severityBetween(catalog, a, b)).toBe(severityFromCode(code))
          expect(severityBetween(catalog, b, a)).toBe(severityFromCode(code))
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('pairKey', () => {
  it('should be the same for both orders of a pair', () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), (a, b) => {
        expect(pairKey(a, b)).toBe(pairKey(b, a))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should differ for different unordered pairs', () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), fc.nat(), fc.nat(), (a, b, c, d) => {
        const same = (a === c && b === d) || (a === d && b === c)
        expect(pairKey(a, b) === pairKey(c, d)).toBe(same)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('isNonDrugName', () => {
  it('should match the curated names regardless of case', () => {
    expect(isNonDrugName('CAFFEINE')).toBe(true)
    expect(isNonDrugName('Grapefruit juice')).toBe(true)
    expect(isNonDrugName('Warfarin')).toBe(false)
  })
})

describe('ddinterDrugUrl', () => {
  it('should link to the drug-detail page by DDInter id', () => {
    const catalog = decodeDdinterFile(fileWith([]))
    const warfarin = catalog.drugs[0]
    expect(warfarin).toBeDefined()
    if (warfarin !== undefined) {
      expect(ddinterDrugUrl(warfarin)).toBe(
        'https://ddinter.scbdd.com/ddinter/drug-detail/DDInter1/'
      )
    }
  })
})

// Helpers

const source = { name: 'DDInter', url: 'https://ddinter.scbdd.com/' }

const fileWith = (pairs: DdinterFile['pairs']): DdinterFile => ({
  source,
  drugs: [
    ['DDInter1', 'Warfarin'],
    ['DDInter2', 'Ibuprofen'],
    ['DDInter3', 'Caffeine'],
  ],
  pairs,
})

/** A structurally valid compact file: unique ordered index pairs into a small drug table. */
const fileArb: fc.Arbitrary<DdinterFile> = fc
  .integer({ min: 1, max: 12 })
  .chain((count) => {
    const drugs = Array.from({ length: count }, (_, i): readonly [string, string] => [
      `DDInter${i + 1}`,
      `Drug ${i + 1}`,
    ])
    const allPairs: (readonly [number, number])[] = []
    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) allPairs.push([a, b])
    }
    return fc.tuple(
      fc.constant(drugs),
      fc.subarray(allPairs),
      fc.array(fc.constantFrom(...SeverityCode.literals), { minLength: allPairs.length })
    )
  })
  .map(([drugs, chosen, codes]) => ({
    source,
    drugs,
    pairs: chosen.map(([a, b], i) => [a, b, codes[i] ?? 3] as const),
  }))
