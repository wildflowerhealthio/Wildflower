/**
 * The dates and times a DICOM header carries, read into `effect/DateTime`
 * values at the boundary.
 *
 * @remarks
 * This module is the one place the reasoning about DICOM time lives; other
 * sites reference it rather than restate it.
 *
 * DICOM's `DA` (`20240315`) and `TM` (`143022`) value representations are
 * wall-clock text with no offset: PS3.3 C.7.6.1 puts the Study, Series and
 * Instance date/time attributes in the local time of the equipment that
 * produced them. FHIR R4's `dateTime` requires an offset the moment a
 * time-of-day is present, so a `DA`+`TM` pair only becomes the instant FHIR
 * wants against a zone the file cannot supply — the importer's
 * `DicomSettings.timeZone`. A `DA` on its own has no time-of-day, so FHIR's
 * `date` and the date-only form of `dateTime` carry it with no zone.
 *
 * Every function here lands on a `DateTime` rather than handing raw text on,
 * so the string form exists only at this boundary.
 *
 * @packageDocumentation
 */
import { DateTime, Option } from 'effect'

/** `YYYYMMDD` — DICOM's `DA` value representation. */
const DA = /^(\d{4})(\d{2})(\d{2})$/

/**
 * `HHMM[SS[.FFFFFF]]` — the part of DICOM's `TM` value representation this
 * importer reads. `TM` also permits a bare `HH`; an hour with no minutes names
 * nothing more precise than the date already does, so it is treated as absent
 * rather than as midnight-plus-an-hour.
 */
const TM = /^(\d{2})(\d{2})(?:(\d{2})(?:\.(\d{1,6}))?)?$/

/** A `DA` taken apart, before any zone is applied. */
interface DateParts {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** A `TM` taken apart, before any zone is applied. */
interface TimeParts {
  readonly hours: number
  readonly minutes: number
  readonly seconds: number
  readonly millis: number
}

/**
 * DICOM pads a value to an even length with a trailing space, and some
 * equipment writes `DA` as `YYYY.MM.DD` (the retired ACR-NEMA form). Strip
 * both before matching.
 */
const normalize = (value: string): string => value.trim().replaceAll('.', '')

const dateParts = (da: string | undefined): Option.Option<DateParts> => {
  if (da === undefined) return Option.none()
  const match = DA.exec(normalize(da))
  if (match === null) return Option.none()
  const [, year = '', month = '', day = ''] = match
  return Option.some({ year: Number(year), month: Number(month), day: Number(day) })
}

const timeParts = (tm: string | undefined): Option.Option<TimeParts> => {
  if (tm === undefined) return Option.none()
  const match = TM.exec(tm.trim())
  if (match === null) return Option.none()
  const [, hours = '', minutes = '', seconds, fraction] = match
  return Option.some({
    hours: Number(hours),
    minutes: Number(minutes),
    seconds: seconds === undefined ? 0 : Number(seconds),
    // `FFFFFF` is a fraction of a second written to up to six places, so it
    // has to be scaled by its own width — `.5` is 500ms, not 5ms.
    millis: fraction === undefined ? 0 : Math.round(Number(`0.${fraction}`) * 1000),
  })
}

/**
 * Whether a built date still names the day the header wrote — `DateTime.make`
 * rolls an impossible `20240230` forward to `Mar 1` rather than rejecting it,
 * and a header never means that.
 */
const namesSameDay = (parts: DateParts, built: DateParts): boolean =>
  built.year === parts.year && built.month === parts.month && built.day === parts.day

/**
 * Read a DICOM `DA` as the `YYYY-MM-DD` calendar date FHIR's `date` carries.
 *
 * @param da - The `DA` value (`20240315`)
 * @returns The ISO calendar date, or `None` when the value is absent, is not a
 *   `DA`, or names an impossible date
 *
 * @remarks
 * No zone is applied and none is needed: a calendar date names a day, not an
 * instant, and FHIR's `date` carries it with no offset.
 */
const dicomCalendarDate = (da: string | undefined): Option.Option<string> =>
  Option.flatMap(dateParts(da), (parts) =>
    Option.flatMap(DateTime.make(parts), (date) =>
      namesSameDay(parts, DateTime.toPartsUtc(date))
        ? Option.some(DateTime.formatIsoDate(date))
        : Option.none()
    )
  )

/**
 * Read a DICOM `DA` + `TM` pair as the instant it names in `timeZone`.
 *
 * @param da - The `DA` value (`20240315`)
 * @param tm - The `TM` value (`143022`)
 * @param timeZone - The IANA zone the acquiring equipment's clock was set to
 *   (`America/Toronto`)
 * @returns The UTC instant, or `None` when either value is absent or
 *   malformed, the date is impossible, or `timeZone` is not a zone
 *
 * @remarks
 * `None` rather than a failure: a header that omits `StudyTime` is ordinary,
 * and the caller falls back to {@link dicomCalendarDate}.
 */
const dicomInstant = (
  da: string | undefined,
  tm: string | undefined,
  timeZone: string
): Option.Option<DateTime.Utc> =>
  Option.flatMap(dateParts(da), (date) =>
    Option.flatMap(timeParts(tm), (time) =>
      Option.flatMap(
        DateTime.makeZoned({ ...date, ...time }, { timeZone, adjustForTimeZone: true }),
        (zoned) =>
          namesSameDay(date, DateTime.toParts(zoned))
            ? Option.some(DateTime.toUtc(zoned))
            : Option.none()
      )
    )
  )

export { dicomCalendarDate, dicomInstant }
