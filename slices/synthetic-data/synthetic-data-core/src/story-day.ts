import { DateTime } from 'effect'

/**
 * A day in a story, counted from the as-of date: `0` is the as-of day itself,
 * `-30` is thirty days before it.
 *
 * @remarks
 * Every date the data set carries is written as a `StoryDay` and only turned
 * into a calendar date against an as-of date, at render time. That is what
 * lets one story be regenerated for any as-of date without drifting: the
 * intervals between events are the story, the calendar dates are not.
 */
type StoryDay = number

/**
 * The calendar day an as-of instant falls on, as midnight UTC.
 *
 * @remarks
 * Only the as-of date's UTC calendar day matters; two instants on the same
 * UTC day render identical data.
 */
const asOfDayOf = (asOf: DateTime.Utc): DateTime.Utc => DateTime.startOf(asOf, 'day')

/**
 * Midnight UTC of a story day.
 *
 * @param asOf - The as-of instant the story is dated from
 * @param storyDay - The day, relative to the as-of day
 */
const toDateTime = (asOf: DateTime.Utc, storyDay: StoryDay): DateTime.Utc =>
  DateTime.add(asOfDayOf(asOf), { days: storyDay })

/** A story day as an ISO calendar date (`YYYY-MM-DD`), the shape FHIR `date` takes. */
const toIsoDate = (asOf: DateTime.Utc, storyDay: StoryDay): string =>
  DateTime.formatIsoDate(toDateTime(asOf, storyDay))

export { asOfDayOf, toDateTime, toIsoDate }
export type { StoryDay }
