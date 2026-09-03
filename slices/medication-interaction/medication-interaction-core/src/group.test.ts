import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import type { Medication } from 'medication-matching-core'
import { tokenize } from 'medication-matching-core'
import { describe, expect, it } from 'vite-plus/test'

import { type DdinterFile, decodeDdinterFile, type InteractionCatalog } from './ddinter.ts'
import { compareTallies, tallyOf, tallyTotal } from './dots.ts'
import { findInteractions, type InteractionRow, type RowGroup } from './group.ts'
import type { OtcCategory } from './otc.ts'
import { SeverityCode, severityRank } from './severity.ts'

describe('findInteractions', () => {
  it('should list each interacting pair under both medications', () => {
    // Arrange
    const medications = [med('1', 'Ibuprofen 200 mg'), med('2', 'Warfarin 5 mg tablet')]

    // Act
    const report = findInteractions(medications, catalog, otc)

    // Assert
    expect(report.medications.map(summary)).toEqual([
      'Ibuprofen 200 mg: Warfarin 5 mg tablet (major)',
      'Warfarin 5 mg tablet: Ibuprofen 200 mg (major)',
    ])
    // The link opens the partner's drug page.
    expect(report.medications[0]?.rows[0]?.url).toContain('DDInter1')
    expect(report.medications[1]?.rows[0]?.url).toContain('DDInter2')
  })

  it('should merge a combination product into one row carrying its worst pair', () => {
    // Arrange: the combination resolves to Aspirin and Warfarin; against
    // Ibuprofen those pairs are moderate and major respectively.
    const medications = [med('1', 'Aspirin / Warfarin'), med('2', 'Ibuprofen')]

    // Act
    const report = findInteractions(medications, catalog, otc)

    // Assert
    const ibuprofen = report.medications.find((group) => group.medication.id === '2')
    expect(ibuprofen?.rows.map(rowSummary)).toEqual(['Aspirin / Warfarin (major)'])
    expect(ibuprofen?.rows[0]?.drug.name).toBe('Warfarin')
    expect(ibuprofen?.tally).toEqual({ major: 1, moderate: 0, minor: 0, unknown: 0 })
  })

  it('should group non-drug interactions under the non-drug', () => {
    const report = findInteractions([med('2', 'Warfarin')], catalog, otc)
    expect(
      report.nonDrugs.map((group) => `${group.drug.name}: ${group.rows.map(rowSummary).join(', ')}`)
    ).toEqual(['Caffeine: Warfarin (minor)'])
  })

  it('should group OTC interactions by category then active, skipping actives already prescribed', () => {
    // Arrange: ibuprofen is on the OTC list but also a patient drug, so it is
    // never an OTC side; loratadine is on the list but interacts with nothing.
    const medications = [med('1', 'Ibuprofen 200 mg'), med('2', 'Warfarin 5 mg tablet')]

    // Act
    const report = findInteractions(medications, catalog, otc)

    // Assert: one category (Allergy yields no rows), Aspirin's Major first.
    expect(report.otc.map((group) => group.category.name)).toEqual(['Pain'])
    const pain = report.otc[0]
    expect(pain?.drugs.map((group) => group.entry.name)).toEqual(['Aspirin', 'Acetaminophen'])
    expect(pain?.drugs[0]?.entry.brands).toBe('Aspirin, ASA')
    expect(pain?.drugs[0]?.rows.map(rowSummary)).toEqual([
      'Warfarin 5 mg tablet (major)',
      'Ibuprofen 200 mg (moderate)',
    ])
    expect(pain?.tally).toEqual({ major: 1, moderate: 2, minor: 0, unknown: 0 })
  })

  it('should leave every section empty for medications DDInter does not carry', () => {
    const report = findInteractions([med('1', 'Tylenol')], catalog, otc)
    expect(report).toEqual({ medications: [], nonDrugs: [], otc: [] })
  })

  it('should leave every section empty for an empty catalog', () => {
    const report = findInteractions([med('1', 'Warfarin')], emptyCatalog, otc)
    expect(report).toEqual({ medications: [], nonDrugs: [], otc: [] })
  })

  it('should always report the same rows whatever the medication order', () => {
    fc.assert(
      fc.property(scenarioArb, ({ catalog: generated, medications }) => {
        const forward = findInteractions(medications, generated, otc)
        const backward = findInteractions(medications.toReversed(), generated, otc)
        expect(backward).toEqual(forward)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always list a medication pair under both sides with the same severity', () => {
    fc.assert(
      fc.property(scenarioArb, ({ catalog: generated, medications }) => {
        const report = findInteractions(medications, generated, otc)
        const seen = new Map(
          report.medications.map((group) => [group.medication.id, group.rows] as const)
        )
        for (const [id, rows] of seen) {
          for (const row of rows) {
            const mirror = seen.get(row.medication.id)?.find((r) => r.medication.id === id)
            expect(mirror?.severity).toBe(row.severity)
          }
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always list exactly the catalog pairs among the patient drugs', () => {
    fc.assert(
      fc.property(scenarioArb, ({ catalog: generated, medications, selected }) => {
        // Act
        const report = findInteractions(medications, generated, otc)

        // Assert: each medication resolves to one drug, so rows are drug pairs.
        const chosen = new Set(selected)
        const expected = [...generated.pairs.keys()].filter((key) =>
          key.split(':').every((index) => chosen.has(Number(index)))
        )
        const seen = new Set<string>()
        for (const group of report.medications) {
          for (const row of group.rows) {
            const [a, b] = [group.drugs[0]?.index ?? -1, row.drug.index]
            seen.add(a < b ? `${a}:${b}` : `${b}:${a}`)
          }
        }
        expect([...seen].toSorted()).toEqual(expected.toSorted())
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always sort groups in severity-count order and rows most severe first', () => {
    fc.assert(
      fc.property(scenarioArb, ({ catalog: generated, medications }) => {
        const report = findInteractions(medications, generated, otc)
        expectSortedByTally(report.otc)
        const rowGroups: readonly (readonly RowGroup[])[] = [
          report.medications,
          report.nonDrugs,
          ...report.otc.map((category) => category.drugs),
        ]
        for (const list of rowGroups) {
          expectSortedByTally(list)
          for (const group of list) {
            const ranks = group.rows.map((row) => severityRank[row.severity])
            expect(ranks).toEqual(ranks.toSorted((x, y) => x - y))
          }
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always tally exactly its rows and omit empty groups', () => {
    fc.assert(
      fc.property(scenarioArb, ({ catalog: generated, medications }) => {
        const report = findInteractions(medications, generated, otc)
        const rowGroups = [
          ...report.medications,
          ...report.nonDrugs,
          ...report.otc.flatMap((category) => category.drugs),
        ]
        for (const group of rowGroups) {
          expect(group.rows.length).toBeGreaterThan(0)
          expect(group.tally).toEqual(tallyOf(group.rows))
        }
        for (const category of report.otc) {
          expect(category.drugs.length).toBeGreaterThan(0)
          expect(tallyTotal(category.tally)).toBe(
            category.drugs.reduce((sum, group) => sum + tallyTotal(group.tally), 0)
          )
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never put a patient drug on the near side of a non-drug or OTC group', () => {
    fc.assert(
      fc.property(scenarioArb, ({ catalog: generated, medications, selected }) => {
        const report = findInteractions(medications, generated, otc)
        const chosen = new Set(selected)
        for (const group of report.nonDrugs) expect(chosen.has(group.drug.index)).toBe(false)
        for (const category of report.otc) {
          for (const group of category.drugs) {
            for (const drug of group.drugs) expect(chosen.has(drug.index)).toBe(false)
          }
        }
        // Rows, on the other hand, are always patient medications.
        const ids = new Set(medications.map((m) => m.id))
        for (const group of [...report.nonDrugs, ...report.otc.flatMap((c) => c.drugs)]) {
          for (const row of group.rows) expect(ids.has(row.medication.id)).toBe(true)
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

const otc: readonly OtcCategory[] = [
  {
    name: 'Pain',
    drugs: [
      { name: 'Aspirin', brands: 'Aspirin, ASA' },
      { name: 'Ibuprofen', brands: 'Advil' },
      { name: 'Acetaminophen' },
    ],
  },
  { name: 'Allergy', drugs: [{ name: 'Loratadine' }] },
]

const med = (id: string, displayName: string): Medication => ({ id, displayName })

const rowSummary = (row: InteractionRow): string =>
  `${row.medication.displayName} (${row.severity})`

const summary = (group: { readonly medication: Medication } & RowGroup): string =>
  `${group.medication.displayName}: ${group.rows.map(rowSummary).join(', ')}`

const expectSortedByTally = (groups: readonly { readonly tally: RowGroup['tally'] }[]): void => {
  for (let i = 1; i < groups.length; i += 1) {
    const previous = groups[i - 1]
    const current = groups[i]
    if (previous === undefined || current === undefined) continue
    expect(compareTallies(previous.tally, current.tally)).toBeLessThanOrEqual(0)
  }
}

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
