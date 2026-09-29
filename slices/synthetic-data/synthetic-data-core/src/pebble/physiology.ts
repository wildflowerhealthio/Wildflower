import type { StoryDay } from '../story-day.ts'

/**
 * What a wrist-worn watch measures, as plain data a story writes day by day:
 * the resting heart rate, walks, the night's sleep and when the watch was
 * charging. `PebbleObservations.render` turns it into minute history and
 * activities.
 *
 * @remarks
 * Every time is whole minutes from a day's local midnight, the day being a
 * `StoryDay`: `420` is 7:00, `-60` 23:00 the evening before, `1500` 1:00 the
 * morning after. The local clock is `utcOffsetHours` from UTC, whole hours so
 * a local hour is a UTC hour, the unit minute history arrives in.
 */

/** A stretch of minutes: its first minute, from its day's local midnight, and how long it lasts. */
interface Span {
  readonly startMinute: number
  /** At least one. */
  readonly durationMinutes: number
}

/** A walk: HealthService's Walk activity, steps at its cadence and the heart rate raised through it. */
interface Walk extends Span {
  /** Steps each minute of the walk, at most 255 (a minute's byte on the wire). */
  readonly stepsPerMinute: number
  /** How far the walk raises the heart rate over resting, reached a few minutes in. */
  readonly heartRateRiseBpm: number
}

/**
 * One night's sleep, timed from the local midnight of the day it ends on, so
 * falling asleep before midnight is a negative minute.
 */
interface Night {
  readonly asleepMinute: number
  /** After `asleepMinute`. */
  readonly awakeMinute: number
  /**
   * The times the sleeper woke and got up, in order, disjoint and strictly
   * between falling asleep and waking. Each splits the night: HealthService
   * records a Sleep activity for every stretch between them.
   */
  readonly wakeUps: readonly Span[]
  /** Deep sleep, HealthService's RestfulSleep, each within one stretch of sleep. */
  readonly restfulSleeps: readonly Span[]
}

/** One day the watch was worn. */
interface PhysiologyDay {
  readonly day: StoryDay
  /** The day's heart rate at rest, awake, before the daily rhythm moves it. */
  readonly restingHeartRateBpm: number
  /** The night that ends on this day, or `null` for none recorded. */
  readonly night: Night | null
  /** In order, disjoint. */
  readonly walks: readonly Walk[]
  /** When the watch was off the wrist on its charger: no minute data, disjoint from the walks. */
  readonly charging: readonly Span[]
}

/** The rhythm the heart rate follows through every day. */
interface Circadian {
  /** How far above resting the heart rate peaks, and below it bottoms out. */
  readonly amplitudeBpm: number
  /** The local minute of day the heart rate is lowest. */
  readonly nadirMinute: number
}

/**
 * What the watch measured over the days it was worn. A day not listed has no
 * minute data, as if the watch were not worn; at most one entry per day.
 *
 * @remarks
 * Activities come from the listed days alone and are not clipped to the
 * minutes that hold data: a night that falls asleep before its day's midnight
 * sends its Sleep activities from that time even when the day before is not
 * listed, and a charge overlapping a night blanks those minutes but not the
 * night's activities. A story that wants them to agree lists the day before,
 * and keeps charges out of its nights.
 */
interface Physiology {
  /** The wearer's local clock, whole hours ahead of UTC (`-5` for Eastern Standard Time). */
  readonly utcOffsetHours: number
  readonly circadian: Circadian
  readonly days: readonly PhysiologyDay[]
}

export type { Circadian, Night, Physiology, PhysiologyDay, Span, Walk }
