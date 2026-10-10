import { DateTime } from 'effect'

import * as Seeding from '../seeding.ts'

/**
 * The story model's calendar: a day in a story, counted from the as-of date —
 * `0` is the as-of day itself, `-30` is thirty days before it. Every other
 * story object dates its events in these.
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

/**
 * An instant on `storyDay`, at a second within `[fromHourUtc, toHourUtc)` UTC
 * hashed from `keys`: the time of day an event the story put on that day
 * happened.
 *
 * @param asOf - The as-of instant the story is dated from
 * @param storyDay - The day the story puts the event on
 * @param keys - What the event belongs to, e.g. a prescription's key and `'written'`
 * @param fromHourUtc - The earliest hour, in `[0, 23]`
 * @param toHourUtc - The hour the window closes at, in `(fromHourUtc, 24]`
 *
 * @remarks
 * The story decides the day; only the time within it is jitter, so the
 * instant never leaves `storyDay`. The hours are UTC: `13`–`23` is 9 am to
 * 7 pm in Toronto, pharmacy hours.
 */
const instantOn = (
  asOf: DateTime.Utc,
  storyDay: StoryDay,
  keys: readonly string[],
  fromHourUtc: number,
  toHourUtc: number
): DateTime.Utc =>
  DateTime.add(toDateTime(asOf, storyDay), {
    seconds: Seeding.integerOf(keys, fromHourUtc * 3600, toHourUtc * 3600 - 1),
  })

export { asOfDayOf, instantOn, toDateTime, toIsoDate }
export type { StoryDay }
