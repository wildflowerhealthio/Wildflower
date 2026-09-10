import type { PositionedTextPage, PositionedTextRun } from 'positioned-text'

/**
 * One run of text on a line, positioned by its left edge — the unit the
 * column bands in `columns.ts` classify.
 */
interface Cell {
  /** The run's left edge, in page points from the left margin. */
  readonly x: number
  /** The run's text, trimmed. Never blank — blank runs are dropped. */
  readonly text: string
}

/**
 * One visual line of a page: the non-blank runs whose top edges fall within
 * {@link LINE_TOLERANCE} of the line's first run, ordered left to right.
 */
interface Line {
  /** The top edge of the line's anchoring run, in page points from the top. */
  readonly y: number
  /** The line's runs, left to right. Never empty. */
  readonly cells: readonly Cell[]
}

/**
 * How far (in page points) a run's top edge may sit from a line's anchor and
 * still belong to that line.
 *
 * @remarks
 * A LifeLabs report mixes two font sizes on one row — a 9.08pt label beside a
 * 9.94pt value, a flag+result pair printed a hair below the test name it
 * belongs to — so the runs of one row sit up to ~4.1pt apart (the
 * `Patient's Phone:` label against its value is the widest). Consecutive
 * rows are 9pt or more apart. Five and a half points sits between the two.
 */
const LINE_TOLERANCE = 5.5

/**
 * Group a page's positioned runs into visual lines: runs are clustered by top
 * edge (a run joins the open line when its `y` is within
 * {@link LINE_TOLERANCE} of that line's first run, otherwise it opens a new
 * one), blank runs are dropped, and each line's cells are ordered by `x`.
 *
 * @param page - The page whose runs to line up
 * @returns The page's lines, top to bottom; a page with only blank runs
 *   yields `[]`
 *
 * @remarks
 * Clustering anchors on the line's *first* run rather than a running mean, so
 * a stack of runs each 3pt below the last can never drift one line into the
 * next — the tolerance is measured from a fixed point.
 */
const linesOf = (page: PositionedTextPage): readonly Line[] => {
  const runs = [...page.runs]
    .filter((run) => run.text.trim().length > 0)
    .toSorted((a, b) => a.y - b.y || a.x - b.x)
  const lines: { y: number; cells: Cell[] }[] = []
  for (const run of runs) {
    const cell = toCell(run)
    const open = lines.at(-1)
    if (open !== undefined && Math.abs(run.y - open.y) <= LINE_TOLERANCE) open.cells.push(cell)
    else lines.push({ y: run.y, cells: [cell] })
  }
  return lines.map((line) => ({
    y: line.y,
    cells: line.cells.toSorted((a, b) => a.x - b.x),
  }))
}

const toCell = (run: PositionedTextRun): Cell => ({ x: run.x, text: run.text.trim() })

/** The line's cells joined by single spaces — the text a reader sees. */
const lineText = (line: Line): string => line.cells.map((cell) => cell.text).join(' ')

export { LINE_TOLERANCE, lineText, linesOf }
export type { Cell, Line }
