import { Array as Arr, DateTime, Option, Order } from 'effect'

import type * as LabNumber from '../entities/lab-number.ts'
import type * as Report from '../entities/report.ts'
import { parsePrintedDateTime } from './dates.ts'

/**
 * A file's printings of one `Lab No`, and which of them the synthesis keeps.
 *
 * @remarks
 * Two runs of pages printing one `Lab No` — a preliminary and a final
 * printing of one report in one PDF, say — are the same report. Only the
 * most recently reported printing is kept; the others are dropped whole,
 * with no row-level merge.
 *
 * @packageDocumentation
 */

/** Every report a file prints under one `Lab No`, in print order. */
type Printings = Arr.NonEmptyReadonlyArray<Report.Type>

/** The reports grouped by the `Lab No` they print, in the order each is first printed. */
const printingsByLabNo = (reports: readonly Report.Type[]): readonly Printings[] => {
  const byLabNo = new Map<LabNumber.Type, Arr.NonEmptyArray<Report.Type>>()
  for (const report of reports) {
    const printings = byLabNo.get(report.labNo)
    if (printings === undefined) byLabNo.set(report.labNo, [report])
    else printings.push(report)
  }
  return [...byLabNo.values()]
}

/** One printing, beside when it was reported and where in the file it is. */
interface DatedPrinting {
  readonly report: Report.Type
  readonly reportedAt: Option.Option<DateTime.Utc>
  readonly printIndex: number
}

/**
 * Printings from the earliest reported to the latest: a printing whose
 * `Reported on:` reads as a time after one whose does not, and a tie, or two
 * that do not read, by which is printed later in the file.
 */
const byReportedThenPrinted: Order.Order<DatedPrinting> = Order.combine(
  Order.mapInput(Option.getOrder(DateTime.Order), ({ reportedAt }: DatedPrinting) => reportedAt),
  Order.mapInput(Order.number, ({ printIndex }: DatedPrinting) => printIndex)
)

/**
 * The printing of one `Lab No` the synthesis keeps: the latest `Reported on:`,
 * read in `timeZone`; on a tie, or when the dates do not read, the one printed
 * later in the file.
 */
const latestPrintingOf = (printings: Printings, timeZone: string): Report.Type =>
  Arr.max(
    Arr.map(printings, (report, printIndex): DatedPrinting => ({
      report,
      reportedAt: parsePrintedDateTime(report.reportedOn, timeZone),
      printIndex,
    })),
    byReportedThenPrinted
  ).report

/** Where a printing is in the file, as its notes name it: `page 3`, `pages 3–4`. */
const pagesText = (pageNumbers: readonly number[]): Option.Option<string> =>
  Option.map(Arr.head(pageNumbers), (first) => {
    const last = pageNumbers.at(-1) ?? first
    return last === first ? `page ${first}` : `pages ${first}–${last}`
  })

/**
 * The note a `Lab No` printed more than once earns: how many printings there
 * are, and which was kept, by its pages and its `Reported on:` as printed.
 */
const keptPrintingNote = (printings: Printings, kept: Report.Type): string => {
  const keptPrintingNumber = printings.indexOf(kept) + 1
  const details = [
    ...Option.toArray(pagesText(kept.pageNumbers)),
    ...(kept.reportedOn === '' ? [] : [`reported on ${kept.reportedOn}`]),
  ]
  const keptText = `Lab No ${kept.labNo} is printed ${printings.length} times, so only printing ${keptPrintingNumber} of ${printings.length} was kept`
  return details.length === 0 ? `${keptText}.` : `${keptText}: ${details.join(', ')}.`
}

export { keptPrintingNote, latestPrintingOf, printingsByLabNo }
