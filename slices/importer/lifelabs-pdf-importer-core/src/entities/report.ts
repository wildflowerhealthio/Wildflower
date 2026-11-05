import type { Document } from '@wildflowerhealthio/positioned-text'
import { Data, Effect, Option, Schema } from 'effect'

import * as Grid from '../document/grid.ts'
import * as PageHeader from '../document/page-header.ts'
import * as PageParts from '../document/page-parts.ts'
import * as LabNumber from './lab-number.ts'
import * as Lab from './lab.ts'
import * as Patient from './patient.ts'
import type * as Section from './section.ts'

/**
 * One lab report — every page carrying the same `Lab No` — and
 * {@link tryFromDocument}, which reads a whole positioned-text document into
 * one report per `Lab No`.
 *
 * @remarks
 * Every field of a report is its own printed text; nothing here is interpreted
 * (a date of service is the printed `Aug 13 2026 13:02`). Interpretation
 * belongs to `fhir/`. `tryFromDocument` is the orchestration over the page
 * regions read by `document/` (`PageParts.split`, `Grid.read`): it groups
 * every page printing one `Lab No` into one report, wherever in the document
 * each page is, and freezes the result. A page that prints no `Lab No`
 * belongs to no report: it is skipped, and its number returned beside the
 * reports.
 *
 * The read of a recognized document is total — masked fields read as `''`, a
 * page with no grid yields a report with no sections, nothing partial-fails.
 * The one failure is up front: a non-empty document with no LifeLabs structure
 * at all (no page carries a `Lab No` or a results-grid heading) fails with
 * {@link UnrecognizedLifeLabsDocument} rather than returning a
 * plausible-looking `[]`. An empty document (no pages) still succeeds with `[]`.
 *
 * The fast-check `arbitrary` that lays a report out for tests lives in the
 * sibling `report-arbitrary.ts` (test-only), so `fast-check` stays out of the
 * production bundle this module anchors.
 *
 * @packageDocumentation
 */

/** One lab report — every page carrying the same `Lab No`. */
interface Type {
  /** The `Lab No:` value (`2024-JJ6330780`). The report's identity. */
  readonly labNo: LabNumber.Type
  /** The `Reference #:` value, or `''`. */
  readonly referenceNumber: string
  /** The `Referring Site ID:` value, or `''`. */
  readonly referringSiteId: string
  readonly patient: Patient.Type
  /** The `Ordered by:` value, or `''`. */
  readonly orderedBy: string
  /** The whole `Copy To:` line as one entry, or `[]` when the report prints none. */
  readonly copyTo: readonly string[]
  /** The `Date of Service:` value as printed (`Aug 13 2026 13:02`), or `''`. */
  readonly dateOfService: string
  /** The `Reported on:` value as printed, or `''`. */
  readonly reportedOn: string
  readonly lab: Lab.Type
  /** The footer status line (`FINAL RESULTS`), or `''`. */
  readonly status: string
  /** The 1-based page numbers of the source document the report spans. */
  readonly pageNumbers: readonly number[]
  readonly sections: readonly Section.Type[]
}

/** What a document reads to: its reports, beside the pages it skipped. */
interface DocumentReports {
  /** One report per `Lab No`, in the order each is first printed. */
  readonly reports: readonly Type[]
  /** The 1-based numbers of the pages that print no `Lab No`, in page order. */
  readonly pagesWithoutLabNo: readonly number[]
}

/**
 * The document handed in is not a LifeLabs "Reports" PDF: it has pages, but
 * none carries a `Lab No` or a results-grid heading.
 */
class UnrecognizedLifeLabsDocument extends Data.TaggedError('UnrecognizedLifeLabsDocument')<{
  readonly pages: number
}> {
  // Data.TaggedError leaves `.message` empty by default; a human-readable
  // description keeps the failure legible to whoever surfaces it.
  override get message(): string {
    return `no LifeLabs report structure across ${this.pages} page(s) — no \`Lab No\` or results-grid heading found`
  }
}

interface Builder {
  readonly labNo: LabNumber.Type
  readonly header: PageHeader.Type
  readonly grid: Grid.State
  readonly pageNumbers: number[]
  status: string
}

const freeze = (report: Builder): Type => {
  const copyTo = PageHeader.get(report.header, 'Copy To:')
  return {
    labNo: report.labNo,
    referenceNumber: PageHeader.get(report.header, 'Reference #:'),
    referringSiteId: PageHeader.get(report.header, 'Referring Site ID:'),
    patient: Patient.fromPageHeader(report.header),
    orderedBy: PageHeader.get(report.header, 'Ordered by:'),
    copyTo: copyTo === '' ? [] : [copyTo],
    dateOfService: PageHeader.get(report.header, 'Date of Service:'),
    reportedOn: PageHeader.get(report.header, 'Reported on:'),
    lab: Lab.fromPageHeader(report.header),
    status: report.status,
    pageNumbers: [...report.pageNumbers],
    sections: Grid.freeze(report.grid),
  }
}

/** A page carrying a signal that this is a LifeLabs report: a `Lab No` or a grid. */
const isLifeLabsPage = (page: PageParts.Type): boolean =>
  page.hasGrid || PageHeader.get(page.header, 'Lab No:') !== ''

/** The `Lab No` a page's header prints, or `None` when it prints none. */
const labNumberIfPrinted = (page: PageParts.Type): Option.Option<LabNumber.Type> =>
  Schema.decodeOption(LabNumber.Schema)(PageHeader.get(page.header, 'Lab No:'))

/**
 * Assemble the reports from already-split pages: every page printing one
 * `Lab No` is a page of that `Lab No`'s report, its grid read on into the
 * report's sections in page order. The header fields come from the report's
 * first page (every page repeats them). A page that prints no `Lab No` is
 * skipped.
 */
const assemble = (parts: readonly PageParts.Type[]): DocumentReports => {
  const reports = new Map<LabNumber.Type, Builder>()
  const pagesWithoutLabNo: number[] = []
  for (const page of parts) {
    const printedLabNo = labNumberIfPrinted(page)
    if (Option.isNone(printedLabNo)) {
      pagesWithoutLabNo.push(page.pageNumber)
      continue
    }
    const labNo = printedLabNo.value
    const report = reports.get(labNo) ?? {
      labNo,
      header: page.header,
      grid: Grid.create(),
      pageNumbers: [],
      status: '',
    }
    reports.set(labNo, report)
    report.pageNumbers.push(page.pageNumber)
    if (page.status !== '') report.status = page.status
    Grid.read(report.grid, page.body)
  }
  return { reports: [...reports.values()].map(freeze), pagesWithoutLabNo }
}

/**
 * Parse a LifeLabs positioned-text document into its lab reports.
 *
 * @param document - The positioned text of a LifeLabs "Reports" PDF
 * @returns One report per `Lab No`, in the order each is first printed,
 *   beside the numbers of the pages that print no `Lab No`; a document with
 *   no pages succeeds with neither
 * @throws Fails with {@link UnrecognizedLifeLabsDocument} when the document has
 *   pages but no LifeLabs structure on any of them
 */
const tryFromDocument = (
  document: Document.Type
): Effect.Effect<DocumentReports, UnrecognizedLifeLabsDocument> => {
  const parts = [...document.pages]
    .toSorted((a, b) => a.pageNumber - b.pageNumber)
    .map(PageParts.split)
  if (parts.length > 0 && !parts.some(isLifeLabsPage)) {
    return Effect.fail(new UnrecognizedLifeLabsDocument({ pages: parts.length }))
  }
  return Effect.succeed(assemble(parts))
}

export { tryFromDocument, UnrecognizedLifeLabsDocument }
export type { DocumentReports, Type }
