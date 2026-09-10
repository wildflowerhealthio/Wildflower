import { Data, Effect } from 'effect'
import type { Document } from 'positioned-text'

import * as Grid from '../document/grid.ts'
import * as PageHeader from '../document/page-header.ts'
import * as PageParts from '../document/page-parts.ts'
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
 * regions read by `document/` (`PageParts.split`, `Grid.read`): it groups the
 * run of pages sharing a `Lab No` into a report — a footer numbered
 * `Page 1 of N` starts a new one — and freezes the result.
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
  readonly labNo: string
  /** The `Reference #:` value, or `''`. */
  readonly referenceNumber: string
  /** The `Referring Site ID:` value, or `''`. */
  readonly referringSiteId: string
  readonly patient: Patient.Type
  /** The `Ordered by:` value, or `''`. */
  readonly orderedBy: string
  /** The `Copy To:` values, one per printed name. */
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
  readonly labNo: string
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

/**
 * Whether `page` continues the open report: the same `Lab No`, and not a page
 * the footer numbers as the first of a new one.
 */
const continues = (open: Builder | undefined, page: PageParts.Type, labNo: string): boolean =>
  open !== undefined && open.labNo === labNo && page.pageIndex?.page !== 1

/** A page carrying a signal that this is a LifeLabs report: a `Lab No` or a grid. */
const isLifeLabsPage = (page: PageParts.Type): boolean =>
  page.hasGrid || PageHeader.get(page.header, 'Lab No:') !== ''

/**
 * Assemble the reports from already-split pages: a page starts a new report
 * when its `Lab No` differs from the open report's or its footer numbers it
 * `Page 1 of N`; otherwise it continues the open report and its grid is read on
 * into the same sections. The header fields come from the report's first page
 * (every page repeats them).
 */
const assemble = (parts: readonly PageParts.Type[]): readonly Type[] => {
  const reports: Builder[] = []
  let open: Builder | undefined
  for (const page of parts) {
    const labNo = PageHeader.get(page.header, 'Lab No:')
    if (!continues(open, page, labNo)) {
      open = { labNo, header: page.header, grid: Grid.create(), pageNumbers: [], status: '' }
      reports.push(open)
    }
    if (open === undefined) throw new Error('unreachable: a report is open once a page is read')
    open.pageNumbers.push(page.pageNumber)
    if (page.status !== '') open.status = page.status
    Grid.read(open.grid, page.body)
  }
  return reports.map(freeze)
}

/**
 * Parse a LifeLabs positioned-text document into its lab reports.
 *
 * @param document - The positioned text of a LifeLabs "Reports" PDF
 * @returns One report per run of pages sharing a `Lab No`, in page order; a
 *   document with no pages succeeds with `[]`
 * @throws Fails with {@link UnrecognizedLifeLabsDocument} when the document has
 *   pages but no LifeLabs structure on any of them
 */
const tryFromDocument = (
  document: Document.Type
): Effect.Effect<readonly Type[], UnrecognizedLifeLabsDocument> => {
  const parts = [...document.pages]
    .toSorted((a, b) => a.pageNumber - b.pageNumber)
    .map(PageParts.split)
  if (parts.length > 0 && !parts.some(isLifeLabsPage)) {
    return Effect.fail(new UnrecognizedLifeLabsDocument({ pages: parts.length }))
  }
  return Effect.succeed(assemble(parts))
}

export { tryFromDocument, UnrecognizedLifeLabsDocument }
export type { Type }
