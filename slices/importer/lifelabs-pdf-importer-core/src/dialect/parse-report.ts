import type { Document, Page } from 'positioned-text'

import * as Column from './column.ts'
import { type Cell, type Line, lineText, linesOf } from './lines.ts'
import type {
  LifeLabsReport,
  ReportGroup,
  ReportLab,
  ReportPatient,
  ReportRow,
  ReportSection,
} from './report.ts'

/**
 * The LifeLabs positioned-text dialect: a patient's printed report pages (as
 * the `wildflower-positioned-text` document the PDF anonymizer extracts and
 * downloads) read into one {@link LifeLabsReport} per `Lab No`.
 *
 * @remarks
 * Every page of a LifeLabs "Reports" PDF repeats the same header (patient
 * block, lab number, dates, ordering provider, laboratory address), then the
 * results grid under a `Test | Flag | Result | Reference Range - Units |
 * Lab Lic. #` heading, then a footer (`Lab - 5687: …`, `Page n of N`,
 * `FINAL RESULTS`). A report is the run of pages sharing a `Lab No`, and a
 * results grid continues across its pages — a section heading repeated at the
 * top of the next page continues the section, and a comment printed there
 * still belongs to the last row of that section.
 *
 * The parse is total over any document the schema admits: a page with no
 * grid yields a report with no sections, a row with no result keeps `''`,
 * nothing throws. What it does *not* do is interpret — see `report.ts`.
 *
 * @packageDocumentation
 */

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
const sameBlock = (a: Cell, b: Cell): boolean => a.x < LAB_COLUMN_X === b.x < LAB_COLUMN_X

/** The top edge below which a line is the page footer, in page points. */
const FOOTER_Y = 715

/**
 * A body line whose text starts with one of these is a page note printed in
 * the grid's left margin, not a group heading — the footer's prefixes.
 */
const FOOTER_PREFIXES = ['Lab - ', 'One or more results on this report']

/** The status line the footer prints (`FINAL RESULTS`). */
const STATUS_PATTERN = /^[A-Z ]+RESULTS$/

/** The per-page header, the same block every page of a report repeats. */
interface PageHeader {
  readonly values: ReadonlyMap<string, string>
  readonly addressLines: readonly string[]
}

/** The `Page n of N` footer line, when the page prints one. */
interface PageIndex {
  readonly page: number
  readonly of: number
}

/** One page split into the three regions the dialect reads. */
interface PageParts {
  readonly pageNumber: number
  readonly header: PageHeader
  readonly body: readonly Line[]
  readonly pageIndex: PageIndex | undefined
  readonly status: string
}

const isLabel = (cell: Cell): boolean => LABELS.has(cell.text)

const isFooterNote = (line: Line): boolean => {
  const first = line.cells[0]
  return first !== undefined && FOOTER_PREFIXES.some((prefix) => first.text.startsWith(prefix))
}

/** The grid's column-heading line: the one carrying `Test`, `Flag` and `Result`. */
const isGridHeading = (line: Line): boolean => {
  const texts = new Set(line.cells.map((cell) => cell.text))
  return texts.has('Test') && texts.has('Flag') && texts.has('Result')
}

/**
 * Read the header labels off the lines above the grid heading: each label's
 * value is the run of cells to its right, within the same block, up to the
 * next label on the line; the laboratory block's unlabelled cells are its
 * address lines.
 */
const parseHeader = (lines: readonly Line[]): PageHeader => {
  const values = new Map<string, string>()
  const addressLines: string[] = []
  for (const line of lines) {
    const consumed = new Set<Cell>()
    line.cells.forEach((cell, index) => {
      if (!isLabel(cell)) return
      consumed.add(cell)
      const value: string[] = []
      for (const next of line.cells.slice(index + 1)) {
        if (isLabel(next) || !sameBlock(cell, next)) break
        consumed.add(next)
        value.push(next.text)
      }
      if (value.length > 0 || !values.has(cell.text)) values.set(cell.text, value.join(' '))
    })
    for (const cell of line.cells) {
      if (!consumed.has(cell) && cell.x >= LAB_COLUMN_X) addressLines.push(cell.text)
    }
  }
  return { values, addressLines }
}

/**
 * The `Page n of N` footer, read unanchored: the status line prints a few
 * points below it, close enough to share a line with it.
 */
const parsePageIndex = (lines: readonly Line[]): PageIndex | undefined => {
  for (const line of lines) {
    const match = /\bPage (\d+) of (\d+)\b/.exec(lineText(line))
    if (match !== null) return { page: Number(match[1]), of: Number(match[2]) }
  }
  return undefined
}

/** The footer's status cell (`FINAL RESULTS`), whichever line it shares. */
const parseStatus = (lines: readonly Line[]): string =>
  lines.flatMap((line) => line.cells).find((cell) => STATUS_PATTERN.test(cell.text))?.text ?? ''

/** Split one page's lines into header, grid body and footer. */
const splitPage = (page: Page.Type): PageParts => {
  const lines = linesOf(page)
  const headingIndex = lines.findIndex(isGridHeading)
  const headerLines =
    headingIndex === -1 ? lines.filter((line) => line.y < FOOTER_Y) : lines.slice(0, headingIndex)
  const afterHeading = headingIndex === -1 ? [] : lines.slice(headingIndex + 1)
  const body = afterHeading.filter((line) => line.y < FOOTER_Y && !isFooterNote(line))
  const footer = lines.filter((line) => line.y >= FOOTER_Y)
  return {
    pageNumber: page.pageNumber,
    header: parseHeader(headerLines),
    body,
    pageIndex: parsePageIndex(footer),
    status: parseStatus(footer),
  }
}

// ---------------------------------------------------------------------------
// The grid: a small mutable builder, one per report, fed page by page.
// ---------------------------------------------------------------------------

interface RowBuilder {
  name: string
  flag: string
  result: string
  referenceRange: string
  unit: string
  labLicence: string
  readonly comments: string[]
}

interface GroupBuilder {
  readonly name: string
  readonly rows: RowBuilder[]
}

interface SectionBuilder {
  readonly name: string
  readonly comments: string[]
  readonly groups: GroupBuilder[]
}

class GridBuilder {
  readonly sections: SectionBuilder[] = []
  private section: SectionBuilder | undefined
  private group: GroupBuilder | undefined
  private row: RowBuilder | undefined
  private licence = ''

  /**
   * A section heading. The same name as the open section (the heading a
   * page break repeats) continues it — the open row stays open so a comment
   * carried over the break still lands on it.
   */
  openSection(name: string): void {
    if (this.section?.name === name) return
    this.section = { name, comments: [], groups: [] }
    this.sections.push(this.section)
    this.group = undefined
    this.row = undefined
  }

  openGroup(name: string, licence: string): void {
    if (licence !== '') this.licence = licence
    const section = this.currentSection()
    this.group = { name, rows: [] }
    section.groups.push(this.group)
    this.row = undefined
  }

  openRow(cells: readonly Cell[]): void {
    const row: RowBuilder = {
      name: '',
      flag: '',
      result: '',
      referenceRange: '',
      unit: '',
      labLicence: '',
      comments: [],
    }
    const parts: Record<'name' | 'flag' | 'result' | 'range' | 'unit' | 'licence', string[]> = {
      name: [],
      flag: [],
      result: [],
      range: [],
      unit: [],
      licence: [],
    }
    cells.forEach((cell, index) => {
      // The leftmost cell is the name whatever its exact x; the rest classify.
      const column = index === 0 ? 'name' : Column.fromCell(cell)
      if (column === 'section' || column === 'group') parts.name.push(cell.text)
      else parts[column].push(cell.text)
    })
    if (parts.licence.length > 0) this.licence = parts.licence.join(' ')
    row.name = parts.name.join(' ')
    row.flag = parts.flag.join(' ')
    row.result = parts.result.join(' ')
    row.referenceRange = parts.range.join(' ')
    row.unit = parts.unit.join(' ')
    row.labLicence = this.licence
    this.currentGroup().rows.push(row)
    this.row = row
  }

  comment(text: string): void {
    if (this.row !== undefined) this.row.comments.push(text)
    else this.currentSection().comments.push(text)
  }

  setLicence(licence: string): void {
    this.licence = licence
  }

  private currentSection(): SectionBuilder {
    if (this.section === undefined) this.openSection('')
    // `openSection` always assigns; the guard above makes this definite.
    return this.sections.at(-1) ?? this.openSectionAndGet()
  }

  private openSectionAndGet(): SectionBuilder {
    this.openSection('')
    const section = this.sections.at(-1)
    if (section === undefined) throw new Error('unreachable: openSection pushes a section')
    return section
  }

  private currentGroup(): GroupBuilder {
    if (this.group === undefined) {
      const section = this.currentSection()
      this.group = { name: '', rows: [] }
      section.groups.push(this.group)
    }
    return this.group
  }
}

/** Feed one page's grid lines into the builder. */
const readBody = (grid: GridBuilder, body: readonly Line[]): void => {
  for (const line of body) {
    const first = line.cells[0]
    if (first === undefined) continue
    switch (Column.fromCell(first)) {
      case 'section':
        grid.openSection(
          lineText({ y: line.y, cells: line.cells.filter((c) => Column.fromCell(c) !== 'licence') })
        )
        for (const cell of line.cells)
          if (Column.fromCell(cell) === 'licence') grid.setLicence(cell.text)
        break
      case 'group': {
        const named = line.cells.filter((cell) => Column.fromCell(cell) !== 'licence')
        const licence = line.cells.filter((cell) => Column.fromCell(cell) === 'licence')
        grid.openGroup(
          named.map((cell) => cell.text).join(' '),
          licence.map((c) => c.text).join(' ')
        )
        break
      }
      case 'name':
        grid.openRow(line.cells)
        break
      case 'licence':
        grid.setLicence(lineText(line))
        break
      case 'flag':
      case 'result':
      case 'range':
      case 'unit':
        // A line with no name is a comment under the open row (or, before any
        // row, under the section) — whatever inner columns its tokens land in.
        grid.comment(lineText(line))
        break
    }
  }
}

const freezeRow = (row: RowBuilder): ReportRow => ({
  name: row.name,
  flag: row.flag,
  result: row.result,
  referenceRange: row.referenceRange,
  unit: row.unit,
  labLicence: row.labLicence,
  comments: [...row.comments],
})

const freezeGroup = (group: GroupBuilder): ReportGroup => ({
  name: group.name,
  rows: group.rows.map(freezeRow),
})

const freezeSection = (section: SectionBuilder): ReportSection => ({
  name: section.name,
  comments: [...section.comments],
  groups: section.groups.map(freezeGroup),
})

// ---------------------------------------------------------------------------
// Reports: pages grouped by Lab No.
// ---------------------------------------------------------------------------

interface ReportBuilder {
  readonly labNo: string
  readonly header: PageHeader
  readonly grid: GridBuilder
  readonly pageNumbers: number[]
  status: string
}

const value = (header: PageHeader, label: string): string => header.values.get(label) ?? ''

const patientOf = (header: PageHeader): ReportPatient => ({
  name: value(header, 'Patient:'),
  age: value(header, 'Age:'),
  sex: value(header, 'Sex:'),
  dateOfBirth: value(header, 'Date of Birth:'),
  healthCardNumber: value(header, 'HC #:'),
  phone: value(header, "Patient's Phone:"),
  patientId: value(header, 'Patient ID:'),
})

// The `Address:` label's own line is the first; the block's unlabelled lines
// below it are the rest.
const labOf = (header: PageHeader): ReportLab => ({
  addressLines: [value(header, 'Address:'), ...header.addressLines].filter((line) => line !== ''),
  telephone: value(header, 'Telephone:'),
  tollFree: value(header, 'Toll Free:'),
  fax: value(header, 'Fax:'),
})

const freezeReport = (report: ReportBuilder): LifeLabsReport => {
  const copyTo = value(report.header, 'Copy To:')
  return {
    labNo: report.labNo,
    referenceNumber: value(report.header, 'Reference #:'),
    referringSiteId: value(report.header, 'Referring Site ID:'),
    patient: patientOf(report.header),
    orderedBy: value(report.header, 'Ordered by:'),
    copyTo: copyTo === '' ? [] : [copyTo],
    dateOfService: value(report.header, 'Date of Service:'),
    reportedOn: value(report.header, 'Reported on:'),
    lab: labOf(report.header),
    status: report.status,
    pageNumbers: [...report.pageNumbers],
    sections: report.grid.sections.map(freezeSection),
  }
}

/**
 * Whether `page` continues the open report: the same `Lab No`, and not a
 * page the footer numbers as the first of a new one.
 */
const continues = (open: ReportBuilder | undefined, page: PageParts, labNo: string): boolean =>
  open !== undefined && open.labNo === labNo && page.pageIndex?.page !== 1

/**
 * Parse a LifeLabs positioned-text document into its lab reports.
 *
 * @param document - The positioned text of a LifeLabs "Reports" PDF
 * @returns One {@link LifeLabsReport} per run of pages sharing a `Lab No`, in
 *   page order; a document with no pages yields `[]`
 *
 * @remarks
 * A page starts a new report when its `Lab No` differs from the open
 * report's or its footer numbers it `Page 1 of N`; otherwise it continues the
 * open report and its grid is read on into the same sections. The header
 * fields come from the report's first page (every page repeats them).
 */
const parseReports = (document: Document.Type): readonly LifeLabsReport[] => {
  const pages = [...document.pages].toSorted((a, b) => a.pageNumber - b.pageNumber)
  const reports: ReportBuilder[] = []
  let open: ReportBuilder | undefined
  for (const page of pages) {
    const parts = splitPage(page)
    const labNo = value(parts.header, 'Lab No:')
    if (!continues(open, parts, labNo)) {
      open = { labNo, header: parts.header, grid: new GridBuilder(), pageNumbers: [], status: '' }
      reports.push(open)
    }
    if (open === undefined) throw new Error('unreachable: a report is open once a page is read')
    open.pageNumbers.push(parts.pageNumber)
    if (parts.status !== '') open.status = parts.status
    readBody(open.grid, parts.body)
  }
  return reports.map(freezeReport)
}

export { parseReports }
