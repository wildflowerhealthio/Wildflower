import { DateTime, Option } from 'effect'

/*
 * The span a FHIR partial date covers, apart from any schema: this module
 * imports no schema and registers no datatype, so `human-name-display.ts`
 * (loaded through `@wildflowerhealthio/fhir-r4/patient-minimal` without the
 * FHIR datatype registry) reads a partial date by the same rule `Period`
 * decodes one.
 */

/** A FHIR `date` / partial `dateTime`: a year, a year-month, or a full date. */
const PARTIAL_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u

/** The span a partial date covers: a day, a month, or a year. */
const precisionOf = (
  month: string | undefined,
  day: string | undefined
): Partial<DateTime.DateTime.PartsForMath> => {
  if (day !== undefined) return { days: 1 }
  if (month !== undefined) return { months: 1 }
  return { years: 1 }
}

/**
 * The last millisecond a partial date covers, in UTC, or `None` when `text` is
 * not a partial date.
 *
 * @param text - A year (`2026`), a year-month (`2026-03`), or a date
 *   (`2026-03-31`)
 * @returns The start of the next year, month or day in UTC, less 1 ms:
 *   `2026-03` → `2026-03-31T23:59:59.999Z`
 *
 * @remarks
 * A FHIR `Period.end` is inclusive to its precision, so this is the instant a
 * date-only end stands for. A partial date carries no zone, so the span is
 * taken in UTC. A partial date that does not parse as a date (`2026-13`) is
 * `None`.
 */
const endOfPartialDate = (text: string): Option.Option<DateTime.Utc> => {
  const partial = PARTIAL_DATE.exec(text)
  if (partial === null) return Option.none()
  const [, year, month, day] = partial
  const start = DateTime.make(`${year}-${month ?? '01'}-${day ?? '01'}T00:00:00Z`)
  return Option.map(start, (spanStart) =>
    DateTime.subtract(DateTime.add(spanStart, precisionOf(month, day)), {
      millis: 1,
    })
  )
}

export { endOfPartialDate }
