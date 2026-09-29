import { DateTime } from 'effect'

import * as Seeded from '../seeded.ts'
import * as StoryDay from '../story-day.ts'

/**
 * Timestamps as the carebook dialect writes them, and the time of day a story
 * day's event happens at.
 */

/**
 * An instant as the carebook dialect writes every timestamp: second
 * precision, always `+00:00` (`2024-03-11T16:54:30+00:00`).
 */
const carebookTimestampOf = (instant: DateTime.Utc): string =>
  `${DateTime.formatIso(instant).slice(0, 19)}+00:00`

/**
 * An instant on `storyDay`, at a second within `[fromHourUtc, toHourUtc)` UTC
 * hashed from `keys`.
 *
 * @remarks
 * The hours are UTC; `13`–`23` is 9 am to 7 pm in Toronto, pharmacy hours.
 * The story decides the day; only the time within it is jitter.
 */
const instantOn = (
  asOf: DateTime.Utc,
  storyDay: StoryDay.StoryDay,
  keys: readonly string[],
  fromHourUtc: number,
  toHourUtc: number
): DateTime.Utc =>
  DateTime.add(StoryDay.toDateTime(asOf, storyDay), {
    seconds: Seeded.integerOf(keys, fromHourUtc * 3600, toHourUtc * 3600 - 1),
  })

export { carebookTimestampOf, instantOn }
