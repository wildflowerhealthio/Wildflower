import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import type { Medication } from 'medication-matching-core'
import { tokenize } from 'medication-matching-core'
import { describe, expect, it } from 'vite-plus/test'

import { type DdinterFile, decodeDdinterFile, type InteractionCatalog, pairKey } from './ddinter.ts'
import { findInteractions, type Interaction } from './group.ts'
import { SeverityCode, severityRank } from './severity.ts'

describe('findInteractions', () => {
  it('should report each pair among the patient drugs once, most severe first', () => {
    // Arrange
    const medications = [med('1', 'Ibuprofen 200 mg'), med('2', 'Warfarin 5 mg tablet')]

    // Act
    const report = findInteractions(medications, catalog, otc)

    // Assert
    expect(report.knownDrugs.map(summary)).toEqual(['Ibuprofen + Warfarin: major'])
    expect(report.knownDrugs[0]?.a.medication?.id).toBe('1')
    expect(report.knownDrugs[0]?.b.medication?.id).toBe('2')
    expect(report.knownDrugs[0]?.url).toContain('DDInter2')
  })

  it('should pair patient drugs with non-drug catalog entries', () => {
    const report = findInteractions([med('2', 'Warfarin')], catalog, otc)
    expect(report.nonDrugs.map(summary)).toEqual(['Warfarin + Caffeine: minor'])
    expect(report.nonDrugs[0]?.b.medication).toBeNull()
  })

  it('should pair patient drugs with OTC actives that are not already patient drugs', () => {
    // Arrange: ibuprofen is on the OTC list but also a patient drug, so it only
    // ever appears as the patient side.
    const medications = [med('1', 'Ibuprofen 200 mg'), med('2', 'Warfarin 5 mg tablet')]

    // Act
    const report = findInteractions(medications, catalog, otc)

    // Assert: major first, then moderate rows by the patient drug's name.
    expect(report.otc.map(summary)).toEqual([
      'Warfarin + Aspirin: major',
      'Ibuprofen + Aspirin: moderate',
      'Warfarin + Acetaminophen: moderate',
    ])
    expect(report.otc[0]?.b.otc?.brands).toBe('Aspirin, ASA')
  })

  it('should leave every group empty for medications DDInter does not carry', () => {
    const report = findInteractions([med('1', 'Tylenol')], catalog, otc)
    expect(report).toEqual({ knownDrugs: [], nonDrugs: [], otc: [] })
  })

  it('should leave every group empty for an empty catalog', () => {
    const report = findInteractions([med('1', 'Warfarin')], emptyCatalog, otc)
    expect(report).toEqual({ knownDrugs: [], nonDrugs: [], otc: [] })
  })

  it('should always report the same pairs whatever the medication order', () => {
    fc.assert(
      fc.property(scenarioArb, ({ catalog: generated, medications }) => {
        // Act
        const forward = findInteractions(medications, generated, otc)
        const backward = findInteractions(medications.toReversed(), generated, otc)

        // Assert
        expect(pairsOf(backward.knownDrugs)).toEqual(pairsOf(forward.knownDrugs))
        expect(pairsOf(backward.nonDrugs)).toEqual(pairsOf(forward.nonDrugs))
        expect(pairsOf(backward.otc)).toEqual(pairsOf(forward.otc))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always report exactly the catalog pairs among the patient drugs, each once', () => {
    fc.assert(
      fc.property(scenarioArb, ({ catalog: generated, medications, selected }) => {
        // Act
        const report = findInteractions(medications, generated, otc)

        // Assert: one row per listed pair with both ends in the patient set.
        const chosen = new Set(selected)
        const expected = [...generated.pairs.keys()].filter((key) =>
          key.split(':').every((index) => chosen.has(Number(index)))
        )
        const seen = report.knownDrugs.map(({ a, b }) => pairKey(a.drug.index, b.drug.index))
        expect(new Set(seen).size).toBe(seen.length)
        expect(seen.toSorted()).toEqual(expected.toSorted())
        for (const { a, b } of report.knownDrugs) {
          expect(chosen.has(a.drug.index)).toBe(true)
          expect(chosen.has(b.drug.index)).toBe(true)
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always sort every group most-severe first', () => {
    fc.assert(
      fc.property(scenarioArb, ({ catalog: generated, medications }) => {
        const report = findInteractions(medications, generated, otc)
        for (const group of [report.knownDrugs, report.nonDrugs, report.otc]) {
          const ranks = group.map((row) => severityRank[row.severity])
          expect(ranks).toEqual(ranks.toSorted((x, y) => x - y))
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never put a patient drug on the far side of an OTC or non-drug row', () => {
    fc.assert(
      fc.property(scenarioArb, ({ catalog: generated, medications, selected }) => {
        const report = findInteractions(medications, generated, otc)
        const chosen = new Set(selected)
        for (const row of [...report.nonDrugs, ...report.otc]) {
          expect(chosen.has(row.a.drug.index)).toBe(true)
          expect(chosen.has(row.b.drug.index)).toBe(false)
          expect(row.b.medication).toBeNull()
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const source = { name: 'DDInter', url: 'https://ddinter.scbdd.com/' }

const emptyCatalog = decodeDdinterFile({ source, drugs: [], pairs: [] })

// Indexes: 0 Warfarin, 1 Ibuprofen, 2 Aspirin, 3 Caffeine, 4 Acetaminophen.
const catalog = decodeDdinterFile({
  source,
  drugs: [
    ['DDInter1', 'Warfarin'],
    ['DDInter2', 'Ibuprofen'],
    ['DDInter3', 'Aspirin'],
    ['DDInter4', 'Caffeine'],
    ['DDInter5', 'Acetaminophen'],
  ],
  pairs: [
    [0, 1, 0],
    [0, 2, 0],
    [1, 2, 1],
    [0, 3, 2],
    [0, 4, 1],
  ],
})

const otc = [
  { name: 'Aspirin', brands: 'Aspirin, ASA' },
  { name: 'Ibuprofen', brands: 'Advil' },
  { name: 'Acetaminophen' },
  { name: 'Loratadine' },
]

const med = (id: string, displayName: string): Medication => ({ id, displayName })

const summary = (row: Interaction): string =>
  `${row.a.drug.name} + ${row.b.drug.name}: ${row.severity}`

const pairsOf = (rows: readonly Interaction[]): readonly string[] =>
  rows.map((row) => `${row.a.drug.index}:${row.b.drug.index}:${row.severity}`)

/**
 * Single-token drug names that survive normalization unchanged, so a
 * medication named exactly after a drug resolves to that drug and only it.
 */
const nameArb = fc
  .stringMatching(/^[a-z]{3,10}$/)
  .filter((name) => tokenize(name).length === 1 && tokenize(name)[0] === name)

interface Scenario {
  readonly catalog: InteractionCatalog
  /** Catalog indexes the medications were named after. */
  readonly selected: readonly number[]
  readonly medications: readonly Medication[]
}

/** A random catalog plus medications named after a subset of its drugs. */
const scenarioArb: fc.Arbitrary<Scenario> = fc
  .uniqueArray(nameArb, { minLength: 1, maxLength: 10 })
  .chain((names) => {
    const allPairs: (readonly [number, number])[] = []
    for (let a = 0; a < names.length; a += 1) {
      for (let b = a + 1; b < names.length; b += 1) allPairs.push([a, b])
    }
    const indexes = names.map((_, index) => index)
    return fc.tuple(
      fc.constant(names),
      fc.subarray(allPairs),
      fc.array(fc.constantFrom(...SeverityCode.literals), { minLength: allPairs.length }),
      fc.subarray(indexes)
    )
  })
  .map(([names, chosen, codes, selected]) => {
    const file: DdinterFile = {
      source,
      drugs: names.map((name, index) => [`DDInter${index + 1}`, name] as const),
      pairs: chosen.map(([a, b], i) => [a, b, codes[i] ?? 3] as const),
    }
    return {
      catalog: decodeDdinterFile(file),
      selected,
      medications: selected.map((index) => med(`m${index}`, names[index] ?? '')),
    }
  })
