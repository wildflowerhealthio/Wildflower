import { DateTime } from 'effect'
import { HealthActivity, type MinuteHistory, WatchSync } from 'fhir-sync-pebble-core-js'
import * as Seeding from 'synthetic-data-fundamentals/seeding'
import { StoryDay } from 'synthetic-data-fundamentals/story'

import { MINUTES_PER_DAY, minuteTimelineOf, sleepStretchesOf } from './minute-timeline.ts'
import * as PebbleWatch from './pebble-watch.ts'
import type { Physiology, Span } from './physiology.ts'

/**
 * The FHIR Sync for Pebble generator: a physiology, as recorded by one watch,
 * as the Observations the phone writes when the watch syncs it — decoded,
 * collected and written by `fhir-sync-pebble-core-js`'s own `HealthActivity` and
 * `WatchSync`, so they are exactly what the app writes.
 *
 * @remarks
 * The watch sends heart rate, steps and movement (vmc) minute history, one
 * Observation per type per UTC hour holding a valid minute, and a Sleep,
 * RestfulSleep or Walk activity per stretch the physiology records. Minutes
 * the watch spent charging are invalid (`E` in every type); an hour with none
 * valid is not sent. Everything is collected as one sync, activities then
 * hours in time order, and written by `WatchSync.toObservations`. Each
 * Observation's id
 * is the watch's for its record, so however the data is split across syncs,
 * the Observations are these. `WatchSync.toTransactionBundle` wraps them as
 * the transaction the phone PUTs.
 */

const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60

/** The minute types the watch sends; the orientation and ambient light it could send are left out. */
const MINUTE_DATA_TYPES: ReadonlyArray<MinuteHistory.DataType> = ['heartRate', 'steps', 'movement']

const { HealthActivityType } = HealthActivity

/**
 * The start of the one sync everything is collected into. `toObservations`
 * reads neither its id nor its connection, so they are fixed.
 */
const SYNC_START = { SyncStart: 1, ConnectionId: 'synthetic-data' }

/** A story minute on the local clock as Unix seconds. */
const unixSecondsOf = (asOf: DateTime.Utc, utcOffsetHours: number, storyMinute: number): number =>
  DateTime.toEpochMillis(StoryDay.toDateTime(asOf, 0)) / 1000 +
  (storyMinute - utcOffsetHours * MINUTES_PER_HOUR) * SECONDS_PER_MINUTE

/** One `HealthActivity` of pebble.h's `activityType`, decoded from the message the watch sends for it. */
const activityOf = (
  activityType: number,
  startSeconds: number,
  endSeconds: number
): HealthActivity.Activity =>
  HealthActivity.decodeMessage({
    ActivityType: activityType,
    ActivityStart: startSeconds,
    ActivityEnd: endSeconds,
  })

/** Every activity `physiology` records, ordered by start and then by `HealthActivity` value. */
const activitiesOf = (
  asOf: DateTime.Utc,
  physiology: Physiology
): ReadonlyArray<HealthActivity.Activity> => {
  const secondsOf = (day: number, minute: number): number =>
    unixSecondsOf(asOf, physiology.utcOffsetHours, day * MINUTES_PER_DAY + minute)
  const activitiesOver = (
    activityType: number,
    day: number,
    spans: readonly Span[]
  ): ReadonlyArray<readonly [number, HealthActivity.Activity]> =>
    spans.map((span) => [
      activityType,
      activityOf(
        activityType,
        secondsOf(day, span.startMinute),
        secondsOf(day, span.startMinute + span.durationMinutes)
      ),
    ])
  return physiology.days
    .flatMap(({ day, night, walks }) => [
      ...(night === null
        ? []
        : [
            ...activitiesOver(HealthActivityType.Sleep, day, sleepStretchesOf(night)),
            ...activitiesOver(HealthActivityType.RestfulSleep, day, night.restfulSleeps),
          ]),
      ...activitiesOver(HealthActivityType.Walk, day, walks),
    ])
    .toSorted(
      ([leftType, left], [rightType, right]) =>
        left.startSeconds - right.startSeconds || leftType - rightType
    )
    .map(([, activity]) => activity)
}

/** The hours of minute history the watch sends: every UTC hour of the listed days with a valid minute. */
const hoursOf = (
  asOf: DateTime.Utc,
  physiology: Physiology,
  seed: number
): ReadonlyArray<MinuteHistory.Hour> => {
  const { firstStoryMinute, minutes } = minuteTimelineOf(physiology, seed)
  return Array.from({ length: minutes.length / MINUTES_PER_HOUR }, (_, hourIndex) => ({
    hourStartSeconds: unixSecondsOf(
      asOf,
      physiology.utcOffsetHours,
      firstStoryMinute + hourIndex * MINUTES_PER_HOUR
    ),
    dataTypes: MINUTE_DATA_TYPES,
    minutes: minutes.slice(hourIndex * MINUTES_PER_HOUR, (hourIndex + 1) * MINUTES_PER_HOUR),
  })).filter((hour) => hour.minutes.some((minute) => minute !== null))
}

/**
 * The Observations FHIR Sync for Pebble writes for `physiology`, recorded by
 * `watch`, for the patient `patientId`.
 *
 * @param asOf - The as-of instant every story day is dated from; only its UTC
 *   calendar day matters
 * @param watch - The watch that recorded it, the Observations' `device`; its
 *   token also seeds the sensor's minute-to-minute wobble
 * @param patientId - The id of the Patient the phone's settings name; every
 *   subject is `Patient/<patientId>`. To file the watch's data on the Patient
 *   a pharmacy import made, pass that Patient's stored id (the one in
 *   `rexallPatientReferenceOf` / `shoppersPatientReferenceOf`'s `reference`)
 * @returns The same Observations for the same inputs
 */
const render = (
  asOf: DateTime.Utc,
  watch: PebbleWatch.PebbleWatch,
  patientId: string,
  physiology: Physiology
): ReadonlyArray<WatchSync.Observation> => {
  const seed = Seeding.integerOf([watch.token, 'minute-wobble'], 0, 0xffff_ffff)
  const sync = hoursOf(asOf, physiology, seed).reduce(
    WatchSync.withHour,
    activitiesOf(asOf, physiology).reduce(WatchSync.withActivity, WatchSync.start(SYNC_START))
  )
  return WatchSync.toObservations(sync, patientId, PebbleWatch.toReference(watch))
}

export { render }
