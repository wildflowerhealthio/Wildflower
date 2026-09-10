import type { Page } from 'positioned-text'

import * as PageFooter from './page-footer.ts'
import * as PageHeader from './page-header.ts'
import * as Table from './table.ts'

/**
 * One page cut into the three regions the dialect reads: the header block, the
 * results-grid body, and the footer (its `Page n of N` index and status).
 *
 * @remarks
 * {@link split} clusters the page's runs into lines ({@link Table.fromPage}),
 * finds the grid heading (`Test | Flag | Result | …`), and slices around it:
 * everything above is the header, everything below and above the footer
 * boundary is the grid body, everything at or below it is the footer. A page
 * with no grid heading is all header — it yields a report with no rows.
 *
 * @packageDocumentation
 */

/** The top edge at or below which a line belongs to the footer, in page points. */
const FOOTER_Y = 715

/** One page split into the three regions the dialect reads. */
interface Type {
  readonly pageNumber: number
  readonly header: PageHeader.Type
  readonly body: readonly Table.Line[]
  readonly pageIndex: PageFooter.Type | undefined
  readonly status: string
  /** Whether the page carried a results-grid heading (`Test | Flag | Result | …`). */
  readonly hasGrid: boolean
}

/** The grid's column-heading line: the one carrying `Test`, `Flag` and `Result`. */
const isGridHeading = (line: Table.Line): boolean => {
  const texts = new Set(line.cells.map((cell) => cell.text))
  return texts.has('Test') && texts.has('Flag') && texts.has('Result')
}

/** Split one page's lines into header, grid body and footer. */
const split = (page: Page.Type): Type => {
  const lines = Table.fromPage(page)
  const headingIndex = lines.findIndex(isGridHeading)
  const headerLines =
    headingIndex === -1 ? lines.filter((line) => line.y < FOOTER_Y) : lines.slice(0, headingIndex)
  const afterHeading = headingIndex === -1 ? [] : lines.slice(headingIndex + 1)
  const body = afterHeading.filter((line) => line.y < FOOTER_Y && !PageFooter.isNote(line))
  const footer = lines.filter((line) => line.y >= FOOTER_Y)
  return {
    pageNumber: page.pageNumber,
    header: PageHeader.fromLines(headerLines),
    body,
    pageIndex: PageFooter.tryIndexFromLines(footer),
    status: PageFooter.statusFromLines(footer),
    hasGrid: headingIndex !== -1,
  }
}

export { split }
export type { Type }
