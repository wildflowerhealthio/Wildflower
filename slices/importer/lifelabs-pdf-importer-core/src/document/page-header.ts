import type * as Table from './table.ts'

/**
 * The per-page header a LifeLabs report repeats on every page — the block of
 * `Label: value` fields the patient and laboratory entities read from.
 *
 * @remarks
 * {@link fromLines} reads one {@link Type} off the lines above a page's grid
 * heading; the header-derived entities (`Patient`, `Lab`) and the report
 * assembly read their fields back out of it by label text through
 * {@link get}. Owning both the shape and its parser here — as `column.ts`
 * and `table.ts` own theirs — keeps every "what the header says" concern in
 * one place, and lets the entities' `fromPageHeader` readers depend on the
 * shape without importing the page splitter that produces it.
 *
 * @packageDocumentation
 */

/** The per-page header, the same block every page of a report repeats. */
interface Type {
  /** Each header label (colon included) mapped to its printed value. */
  readonly values: ReadonlyMap<string, string>
  /** The laboratory block's unlabelled lines, below `Address:`, top to bottom. */
  readonly addressLines: readonly string[]
}

/** The value printed for `label`, or `''` when the header carries none. */
const get = (header: Type, label: string): string => header.values.get(label) ?? ''

/** The header labels the dialect reads, exactly as printed (colon included). */
const LABELS = new Set([
  'Patient:',
  'Lab No:',
  'Reference #:',
  'Age:',
  'Sex:',
  'Patient ID:',
  'Date of Birth:',
  'Referring Site ID:',
  'HC #:',
  "Patient's Phone:",
  'Date of Service:',
  'Reported on:',
  'Ordered by:',
  'Copy To:',
  'Address:',
  'Telephone:',
  'Toll Free:',
  'Fax:',
])

/**
 * The left edge of the laboratory block — the `Address:` / `Telephone:` /
 * `Toll Free:` / `Fax:` labels and their values, printed in a column of their
 * own at the top right. A label's value never crosses this edge: `HC #:` on
 * the left and `Toronto, Ontario` on the right share a line but not a field.
 */
const LAB_COLUMN_X = 480

/** Whether two cells sit in the same header block (patient/report vs. lab). */
const sameBlock = (a: Table.Cell, b: Table.Cell): boolean =>
  a.x < LAB_COLUMN_X === b.x < LAB_COLUMN_X

const isLabel = (cell: Table.Cell): boolean => LABELS.has(cell.text)

/**
 * Read the header labels off the lines above the grid heading: each label's
 * value is the run of cells to its right, within the same block, up to the
 * next label on the line; the laboratory block's unlabelled cells are its
 * address lines.
 */
const fromLines = (lines: readonly Table.Line[]): Type => {
  const values = new Map<string, string>()
  const addressLines: string[] = []
  for (const line of lines) {
    const consumed = new Set<Table.Cell>()
    line.cells.forEach((cell, index) => {
      if (!isLabel(cell)) return
      consumed.add(cell)
      const parts: string[] = []
      for (const next of line.cells.slice(index + 1)) {
        if (isLabel(next) || !sameBlock(cell, next)) break
        consumed.add(next)
        parts.push(next.text)
      }
      if (parts.length > 0 || !values.has(cell.text)) values.set(cell.text, parts.join(' '))
    })
    for (const cell of line.cells) {
      if (!consumed.has(cell) && cell.x >= LAB_COLUMN_X) addressLines.push(cell.text)
    }
  }
  return { values, addressLines }
}

export { fromLines, get }
export type { Type }
