import { Arbitrary } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  buildDdinterFile,
  type DdinterCsvRow,
  ddinterCsvColumns,
  parseCsv,
  parseDdinterCsv,
} from './ddinter-csv.ts'
import { decodeDdinterFile, severityBetween } from './ddinter.ts'
import { Severity, severityRank } from './severity.ts'

describe('parseCsv', () => {
  it('should split fields on commas and rows on either line ending', () => {
    expect(parseCsv('a,b\r\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('should keep commas, newlines and doubled quotes inside quoted fields', () => {
    expect(parseCsv('"x, y","line\nbreak","say ""hi"""')).toEqual([
      ['x, y', 'line\nbreak', 'say "hi"'],
    ])
  })

  it('should produce no rows for empty text', () => {
    expect(parseCsv('')).toEqual([])
  })

  it('should always invert a CSV rendering of any grid', () => {
    fc.assert(
      fc.property(fc.array(fc.array(fc.string(), { minLength: 1 }), { minLength: 1 }), (grid) => {
        expect(parseCsv(renderCsv(grid))).toEqual(grid)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('parseDdinterCsv', () => {
  it('should locate the DDInter columns by header name', () => {
    // Arrange: an extra leading column and a reordered header.
    const text = [
      'Extra,Level,DDInterID_B,Drug_B,DDInterID_A,Drug_A',
      'x,Major,DDInter2,Ibuprofen,DDInter1,Warfarin',
    ].join('\n')

    // Act
    const rows = parseDdinterCsv(text)

    // Assert
    expect(rows).toEqual([warfarinIbuprofen])
  })

  it('should skip blank lines', () => {
    const text = `${header}\nDDInter1,Warfarin,DDInter2,Ibuprofen,Major\n\n,,,,\n`
    expect(parseDdinterCsv(text)).toHaveLength(1)
  })

  it('should return no rows for a header-only or empty file', () => {
    expect(parseDdinterCsv(header)).toEqual([])
    expect(parseDdinterCsv('')).toEqual([])
  })

  it('should throw when a DDInter column is missing', () => {
    expect(() => parseDdinterCsv('DDInterID_A,Drug_A,DDInterID_B,Drug_B\na,b,c,d')).toThrow(
      /missing the "Level" column/
    )
  })

  it('should throw on an unrecognised Level rather than drop the row', () => {
    expect(() => parseDdinterCsv(`${header}\nDDInter1,Warfarin,DDInter2,Ibuprofen,Severe`)).toThrow(
      /line 2: unrecognised Level "Severe"/
    )
  })

  it('should throw on an empty id or name', () => {
    expect(() => parseDdinterCsv(`${header}\nDDInter1,,DDInter2,Ibuprofen,Major`)).toThrow(
      /line 2: empty drug id or name/
    )
  })

  it('should always read back the rows a DDInter CSV was rendered from', () => {
    fc.assert(
      fc.property(fc.array(rowArb), (rows) => {
        expect(parseDdinterCsv(renderRows(rows))).toEqual(rows)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('buildDdinterFile', () => {
  it('should emit each unordered pair once with the most severe level seen', () => {
    // Arrange: the same pair from two ATC files, once each way round, disagreeing.
    const rows: DdinterCsvRow[] = [
      warfarinIbuprofen,
      { ...warfarinIbuprofen, severity: 'moderate' },
      {
        idA: 'DDInter2',
        nameA: 'Ibuprofen',
        idB: 'DDInter1',
        nameB: 'Warfarin',
        severity: 'unknown',
      },
    ]

    // Act
    const file = buildDdinterFile(rows, source)

    // Assert
    expect(file.drugs).toEqual([
      ['DDInter1', 'Warfarin'],
      ['DDInter2', 'Ibuprofen'],
    ])
    expect(file.pairs).toEqual([[0, 1, 0]])
  })

  it('should drop a drug paired with itself', () => {
    const file = buildDdinterFile(
      [{ ...warfarinIbuprofen, idB: 'DDInter1', nameB: 'Warfarin' }],
      source
    )
    expect(file.pairs).toEqual([])
  })

  it('should always build a file the decoder accepts, order-independently', () => {
    fc.assert(
      fc.property(fc.array(rowArb), (rows) => {
        // Act
        const file = buildDdinterFile(rows, source)
        const reversed = buildDdinterFile(rows.toReversed(), source)
        const catalog = decodeDdinterFile(file)

        // Assert: stable output, and every input pair is reported at its most
        // severe level.
        expect(reversed.pairs).toEqual(file.pairs)
        expect(reversed.drugs.map(([id]) => id)).toEqual(file.drugs.map(([id]) => id))
        const indexOf = new Map(catalog.drugs.map((drug) => [drug.id, drug.index]))
        for (const row of rows) {
          if (row.idA === row.idB) continue
          const a = indexOf.get(row.idA)
          const b = indexOf.get(row.idB)
          expect(a).toBeDefined()
          expect(b).toBeDefined()
          if (a === undefined || b === undefined) return
          const reported = severityBetween(catalog, a, b)
          expect(reported).not.toBeNull()
          if (reported === null) return
          expect(severityRank[reported]).toBeLessThanOrEqual(severityRank[row.severity])
        }
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

// Helpers

const source = { name: 'DDInter', url: 'https://ddinter.scbdd.com/' }

const header = ddinterCsvColumns.join(',')

const warfarinIbuprofen: DdinterCsvRow = {
  idA: 'DDInter1',
  nameA: 'Warfarin',
  idB: 'DDInter2',
  nameB: 'Ibuprofen',
  severity: 'major',
}

/**
 * Quote a CSV field whenever it holds a delimiter, quote or line break — and
 * when it is empty, so a grid ending in a lone empty field still renders to
 * something (bare empty text is the *no rows* case).
 */
const quote = (field: string): string =>
  field === '' || /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field

const renderCsv = (grid: readonly (readonly string[])[]): string =>
  grid.map((row) => row.map(quote).join(',')).join('\n')

const renderRows = (rows: readonly DdinterCsvRow[]): string =>
  renderCsv([
    [...ddinterCsvColumns],
    ...rows.map((row) => [
      row.idA,
      row.nameA,
      row.idB,
      row.nameB,
      // DDInter capitalises its levels; the parser is case-insensitive.
      row.severity.toUpperCase(),
    ]),
  ])

/** A non-blank, trim-stable cell (the parser trims, so a padded input cannot round-trip). */
const cellArb = fc.string({ minLength: 1 }).filter((s) => s.trim() === s)

/** Ids drawn from a small pool so pairs repeat across rows. */
const idArb = fc.integer({ min: 1, max: 6 }).map((n) => `DDInter${n}`)

const rowArb: fc.Arbitrary<DdinterCsvRow> = fc.record({
  idA: idArb,
  nameA: cellArb,
  idB: idArb,
  nameB: cellArb,
  severity: Arbitrary.make(Severity),
})
