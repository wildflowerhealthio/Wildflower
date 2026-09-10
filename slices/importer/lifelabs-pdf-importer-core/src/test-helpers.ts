import type { PositionedTextDocument, PositionedTextPage, PositionedTextRun } from 'positioned-text'

import type { LifeLabsReport, ReportRow } from './dialect/report.ts'

/**
 * Lay a {@link LifeLabsReport} out as the positioned text a LifeLabs PDF
 * prints — the inverse of `parseReports`, for tests: a report laid out and
 * parsed back is the same report, and every layout constant here is the
 * printed grid's (the x of each column, the header labels, the footer).
 *
 * @remarks
 * Test-only on purpose: production never renders a report, and the package's
 * `./test-helpers` subpath keeps this out of the main entry. The layout is
 * faithful where the parser is sensitive — column x positions, header label
 * text, the `Page n of N` footer, the lab-licence marker line — and
 * indifferent elsewhere (glyph widths, font names).
 *
 * @packageDocumentation
 */

/** US Letter, as the reports print. */
const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792

/** The x each grid column prints at (see `columns.ts` for the bands). */
const X = {
  section: 0,
  group: 14,
  name: 28,
  flag: 255,
  result: 283,
  range: 391,
  unit: 485,
  licence: 586,
  reportLabel: 213,
  labLabel: 484,
  labValue: 527,
} as const

/** The y the grid heading prints at; body rows start below it. */
const GRID_HEADING_Y = 141
const FIRST_ROW_Y = 159
const ROW_STEP = 12
/** The last y a body line may print at before the footer. */
const LAST_ROW_Y = 700
const FOOTER_Y = 723

/** Options for {@link layoutReport}. */
interface LayoutOptions {
  /** The page number the report's first page gets (default `1`). */
  readonly firstPageNumber?: number
  /** Whether to print a page's footer status line (default `true`). */
  readonly withStatus?: boolean
}

const run = (text: string, x: number, y: number, fontSize = 9.94): PositionedTextRun => ({
  text,
  x,
  y,
  width: text.length * fontSize * 0.5,
  fontSize,
})

/** One body line, as the cells it prints at their column x's. */
interface BodyLine {
  readonly cells: readonly (readonly [x: number, text: string])[]
}

const rowLines = (row: ReportRow, licence: string | undefined): BodyLine[] => {
  const cells: (readonly [number, string])[] = [[X.name, row.name]]
  if (row.flag !== '') cells.push([X.flag, row.flag])
  if (row.result !== '') cells.push([X.result, row.result])
  if (row.referenceRange !== '') cells.push([X.range, row.referenceRange])
  if (row.unit !== '') cells.push([X.unit, row.unit])
  if (licence !== undefined) cells.push([X.licence, licence])
  return [{ cells }, ...row.comments.map((comment) => ({ cells: [[X.result, comment] as const] }))]
}

/**
 * The report's grid as a flat list of lines, section by section, with a
 * lab-licence marker printed wherever the licence in force changes — the way
 * the PDF prints `#5687` once above the rows it covers.
 */
const bodyLines = (report: LifeLabsReport): BodyLine[] => {
  const lines: BodyLine[] = []
  let licence = ''
  for (const section of report.sections) {
    lines.push({ cells: [[X.section, section.name]] })
    for (const comment of section.comments) lines.push({ cells: [[X.result, comment]] })
    for (const group of section.groups) {
      if (group.name !== '') lines.push({ cells: [[X.group, group.name]] })
      for (const row of group.rows) {
        const changed = row.labLicence !== licence
        licence = row.labLicence
        lines.push(...rowLines(row, changed && licence !== '' ? licence : undefined))
      }
    }
  }
  return lines
}

const headerRuns = (report: LifeLabsReport): PositionedTextRun[] => {
  const { patient, lab } = report
  const label = (text: string, x: number, y: number): PositionedTextRun => run(text, x, y, 9.08)
  const runs: PositionedTextRun[] = [
    label('Patient:', 0, 15),
    run(patient.name, 37, 13),
    label('Lab No:', X.reportLabel, 15),
    run(report.labNo, 250, 13),
    label('Reference #:', X.reportLabel, 30),
    run(report.referenceNumber, 271, 28),
    label('Age:', 0, 45),
    run(patient.age, 25, 43),
    label('Sex:', 113, 45),
    run(patient.sex, 137, 43),
    label('Patient ID:', X.reportLabel, 45),
    run(patient.patientId, 261, 43),
    label('Date of Birth:', 0, 57),
    run(patient.dateOfBirth, 59, 55),
    label('Referring Site ID:', X.reportLabel, 57),
    run(report.referringSiteId, 290, 55),
    label('Address:', X.labLabel, 64),
    label('HC #:', 0, 72),
    run(patient.healthCardNumber, 29, 71),
    label("Patient's Phone:", 0, 87),
    run(patient.phone, 72, 83),
    label('Date of Service:', X.reportLabel, 87),
    run(report.dateOfService, 284, 83),
    label('Telephone:', X.labLabel, 96),
    run(lab.telephone, 556, 96),
    label('Reported on:', X.reportLabel, 99),
    run(report.reportedOn, 271, 99),
    label('Toll Free:', X.labLabel, 105),
    run(lab.tollFree, 556, 105),
    label('Ordered by:', 0, 114),
    run(report.orderedBy, 60, 111),
    label('Fax:', X.labLabel, 117),
    run(lab.fax, 556, 117),
    label('Copy To:', 0, 126),
    run(report.copyTo.join(' '), 60, 126),
    label('Test', 110, GRID_HEADING_Y),
    label('Flag', 251, GRID_HEADING_Y),
    label('Result', 283, GRID_HEADING_Y),
    label('Reference Range - Units', 391, GRID_HEADING_Y),
    label('Lab Lic. #', 569, GRID_HEADING_Y),
  ]
  // The address prints one line per entry, down the lab column — at the ys the
  // PDF uses, which share lines with `HC #:` and `Patient's Phone:` on the left.
  lab.addressLines.forEach((line, index) => runs.push(run(line, X.labValue, 64 + index * 9)))
  return runs
}

const footerRuns = (
  page: number,
  of: number,
  status: string,
  withStatus: boolean
): PositionedTextRun[] => [
  run('Lab - 5687: LifeLabs, 100 International Blvd., Toronto, Ontario.', X.group, FOOTER_Y),
  run('Page', 269, FOOTER_Y + 12),
  run(String(page), 297, FOOTER_Y + 12),
  run('of', 312, FOOTER_Y + 12),
  run(String(of), 326, FOOTER_Y + 12),
  ...(withStatus && status !== '' ? [run(status, X.group, FOOTER_Y + 15)] : []),
]

/**
 * Lay one report out as positioned-text pages, breaking the grid across pages
 * the way the PDF does — the section heading repeated at the top of the
 * continuation page.
 *
 * @param report - The report to print
 * @param options - Page numbering and whether the footer status line prints
 * @returns The report's pages, in order
 */
const layoutReport = (
  report: LifeLabsReport,
  options: LayoutOptions = {}
): readonly PositionedTextPage[] => {
  const firstPageNumber = options.firstPageNumber ?? 1
  const withStatus = options.withStatus ?? true
  const lines = bodyLines(report)
  const rowsPerPage = Math.floor((LAST_ROW_Y - FIRST_ROW_Y) / ROW_STEP)
  // Split into pages; a continuation page re-prints the open section heading.
  const pages: BodyLine[][] = []
  let current: BodyLine[] = []
  let openSection: string | undefined
  for (const line of lines) {
    const first = line.cells[0]
    if (first !== undefined && first[0] === X.section) openSection = first[1]
    if (current.length >= rowsPerPage) {
      pages.push(current)
      current = openSection === undefined ? [] : [{ cells: [[X.section, openSection]] }]
    }
    current.push(line)
  }
  pages.push(current)
  const of = pages.length
  return pages.map((bodyOfPage, index) => ({
    pageNumber: firstPageNumber + index,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    runs: [
      ...headerRuns(report),
      ...bodyOfPage.flatMap((line, lineIndex) =>
        line.cells.map(([x, text]) => run(text, x, FIRST_ROW_Y + lineIndex * ROW_STEP))
      ),
      ...footerRuns(index + 1, of, report.status, withStatus),
    ],
  }))
}

/**
 * Lay several reports out as one positioned-text document, pages numbered
 * consecutively — a multi-report "Reports" PDF.
 *
 * @param reports - The reports to print, in order
 * @param fileName - The document's `fileName` (default `Reports.pdf`)
 * @returns The document
 */
const layoutDocument = (
  reports: readonly LifeLabsReport[],
  fileName = 'Reports.pdf'
): PositionedTextDocument => {
  const pages: PositionedTextPage[] = []
  for (const report of reports) {
    pages.push(...layoutReport(report, { firstPageNumber: pages.length + 1 }))
  }
  return { format: 'wildflower-positioned-text', version: 1, fileName, pages }
}

export { layoutDocument, layoutReport }
export type { LayoutOptions }
