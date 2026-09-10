import type { Cell } from './lines.ts'

/**
 * The columns a LifeLabs report body row is laid out in, named by the band of
 * `x` (page points from the left margin) each occupies.
 *
 * @remarks
 * The report prints a fixed grid — `Test | Flag | Result | Reference Range -
 * Units | Lab Lic. #` — with every cell left-aligned at one of a handful of
 * x positions: section headings at 0, group headings at ~14, test names at
 * ~28, flags at ~255, results and comment text at ~283, reference ranges at
 * ~391, units at ~485, lab licence numbers at ~586. The bands below sit
 * halfway between neighbours so a run that lands a point or two off (a
 * different font, a kerned first glyph) still classifies. A comment line's
 * inline tokens (`Follicular: 77-921 pmol/L`) can land in the range band too,
 * which is why a line's *kind* is decided from its leftmost cell in
 * `parse-report.ts` before the bands are read.
 */
type Column = 'section' | 'group' | 'name' | 'flag' | 'result' | 'range' | 'unit' | 'licence'

/** The right edge (exclusive) of each band, left to right. */
const BAND_EDGES: readonly (readonly [Column, number])[] = [
  ['section', 8],
  ['group', 22],
  ['name', 245],
  ['flag', 275],
  ['result', 385],
  ['range', 480],
  ['unit', 575],
]

/** The column a cell's left edge falls in. */
const fromCell = (cell: Cell): Column => {
  for (const [column, edge] of BAND_EDGES) if (cell.x < edge) return column
  return 'licence'
}

export { fromCell }
export type { Column }
