import type * as Table from './table.ts'

/**
 * The page footer a LifeLabs report prints below the grid: the `FINAL RESULTS`
 * status line, and the `Lab - …` note that marks a body line as a footnote
 * rather than a group heading.
 *
 * @remarks
 * Read unanchored within the footer region `page.ts` hands it — the status
 * line prints a few points below the `Page n of N` index, close enough to
 * share a line with it, so it is found by scanning the region rather than by
 * fixed position.
 *
 * @packageDocumentation
 */

/**
 * A body line whose text starts with one of these is a page note printed in
 * the grid's left margin, not a group heading — the footer's prefixes.
 */
const NOTE_PREFIXES = ['Lab - ', 'One or more results on this report']

/** The status line the footer prints (`FINAL RESULTS`). */
const STATUS_PATTERN = /^[A-Z ]+RESULTS$/

/** Whether `line` is a footer note printed in the grid's left margin. */
const isNote = (line: Table.Line): boolean => {
  const first = line.cells[0]
  return first !== undefined && NOTE_PREFIXES.some((prefix) => first.text.startsWith(prefix))
}

/** The footer's status cell (`FINAL RESULTS`), whichever line it shares, or `''`. */
const statusFromLines = (lines: readonly Table.Line[]): string =>
  lines.flatMap((line) => line.cells).find((cell) => STATUS_PATTERN.test(cell.text))?.text ?? ''

export { isNote, statusFromLines }
