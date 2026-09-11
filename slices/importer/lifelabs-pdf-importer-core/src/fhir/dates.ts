import { DateTime, Option } from 'effect'

/**
 * The dates a LifeLabs report prints, read into values FHIR can carry.
 *
 * @remarks
 * The report prints every timestamp in the laboratory's local time with no
 * zone (`Aug 13 2026 13:02`), so turning one into the instant FHIR's
 * `dateTime`-with-time and `instant` require needs a zone the report cannot
 * supply — the importer's `timeZone` setting. A date of birth (`Aug 13 1981`)
 * has no time and stays a calendar date.
 *
 * @packageDocumentation
 */

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

/** `Mon D YYYY[ HH:MM]` — the report's header timestamp shape. */
const PRINTED = /^([A-Za-z]{3}) (\d{1,2}) (\d{4})(?: (\d{1,2}):(\d{2}))?$/

/** A printed timestamp taken apart, before any zone is applied. */
interface PrintedParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hours: number
  readonly minutes: number
}

const parts = (text: string): Option.Option<PrintedParts> => {
  const match = PRINTED.exec(text.trim())
  if (match === null) return Option.none()
  const [, monthText = '', dayText = '', yearText = '', hoursText, minutesText] = match
  const month = MONTHS[monthText.toLowerCase()]
  if (month === undefined) return Option.none()
  return Option.some({
    year: Number(yearText),
    month,
    day: Number(dayText),
    hours: hoursText === undefined ? 0 : Number(hoursText),
    minutes: minutesText === undefined ? 0 : Number(minutesText),
  })
}

/**
 * Whether a built date still names the printed day — `DateTime.make` rolls an
 * impossible `Feb 30` forward to `Mar 2` rather than rejecting it, and a
 * report never means that.
 */
const namesSameDay = (
  p: PrintedParts,
  built: { readonly year: number; readonly month: number; readonly day: number }
): boolean => built.year === p.year && built.month === p.month && built.day === p.day

/**
 * Read a printed `Mon D YYYY HH:MM` (or `Mon D YYYY`) as the instant it names
 * in `timeZone`.
 *
 * @param text - The printed value (`Aug 13 2026 13:02`)
 * @param timeZone - The IANA zone the report's clock is in (`America/Toronto`)
 * @returns The UTC instant, or `None` when the text is not a printed
 *   timestamp, names an impossible date, or `timeZone` is not a zone
 *
 * @remarks
 * A masked value (`Xxx 00 0000`, what the anonymizer leaves) is `None`, not a
 * failure: the field is simply absent from the resource.
 */
const parsePrintedDateTime = (text: string, timeZone: string): Option.Option<DateTime.Utc> =>
  Option.flatMap(parts(text), (p) =>
    Option.flatMap(
      DateTime.makeZoned(
        { year: p.year, month: p.month, day: p.day, hours: p.hours, minutes: p.minutes },
        { timeZone, adjustForTimeZone: true }
      ),
      (zoned) =>
        namesSameDay(p, DateTime.toParts(zoned))
          ? Option.some(DateTime.toUtc(zoned))
          : Option.none()
    )
  )

/**
 * Read a printed `Mon D YYYY` as the `YYYY-MM-DD` calendar date FHIR's `date`
 * carries — a date of birth has no zone to apply.
 *
 * @param text - The printed value (`Aug 13 1981`)
 * @returns The ISO calendar date, or `None` when the text is not a printed
 *   date or names an impossible one
 */
const parsePrintedDate = (text: string): Option.Option<string> =>
  Option.flatMap(parts(text), (p) =>
    Option.flatMap(DateTime.make({ year: p.year, month: p.month, day: p.day }), (date) =>
      namesSameDay(p, DateTime.toPartsUtc(date))
        ? Option.some(DateTime.formatIsoDate(date))
        : Option.none()
    )
  )

export { parsePrintedDate, parsePrintedDateTime }
