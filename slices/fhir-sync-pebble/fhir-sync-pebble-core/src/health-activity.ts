import { requireInteger, requirePayload } from './fields.ts'

/**
 * Health Activity: the watch's activity messages in, one FHIR Observation per
 * activity out.
 *
 * @remarks
 * A namespace module — consumers speak `HealthActivity.Activity`,
 * `HealthActivity.decodeMessage`, `HealthActivity.toObservation`. The watch
 * sends one message per activity HealthService recorded (`ActivityType`,
 * `ActivityStart`, `ActivityEnd`) and ends its sync with `ActivityCount`; see
 * `apps/fhir-sync-pebble/src/c/sync.h` for that side.
 *
 * @packageDocumentation
 */

/** A FHIR Coding, every field present. */
interface Coding {
  readonly system: string
  readonly code: string
  readonly display: string
}

/**
 * The code system for Pebble's HealthService: its SDK docs page, with each
 * `HealthActivity` name as a code.
 */
const HEALTH_SERVICE_SYSTEM =
  'https://developer.repebble.com/docs/c/Foundation/Event_Service/HealthService/'

/** Observation.code for every activity. */
const HEALTH_ACTIVITY_CODING: Coding = {
  system: HEALTH_SERVICE_SYSTEM,
  code: 'HealthActivity',
  display: 'Pebble Health Activity',
}

/** Observation.category for activities, and for the minute types that measure one. */
const ACTIVITY_CATEGORY_CODING: Coding = {
  system: 'http://terminology.hl7.org/CodeSystem/observation-category',
  code: 'activity',
  display: 'Activity',
}

/**
 * The value coding for each `HealthActivity`, keyed by its value in pebble.h
 * (one bit each). `HealthActivityNone` (0) is never recorded, so it has none.
 */
const ACTIVITY_CODINGS: Readonly<Record<number, Coding>> = {
  1: { system: HEALTH_SERVICE_SYSTEM, code: 'HealthActivitySleep', display: 'Sleeping' },
  2: {
    system: HEALTH_SERVICE_SYSTEM,
    code: 'HealthActivityRestfulSleep',
    display: 'Restful Sleeping',
  },
  4: { system: HEALTH_SERVICE_SYSTEM, code: 'HealthActivityWalk', display: 'Walking' },
  8: { system: HEALTH_SERVICE_SYSTEM, code: 'HealthActivityRun', display: 'Running' },
  16: { system: HEALTH_SERVICE_SYSTEM, code: 'HealthActivityOpenWorkout', display: 'Open Workout' },
}

/** One activity the watch recorded, decoded from its AppMessage. */
interface Activity {
  /** The value coding for the activity's `HealthActivity`. */
  readonly coding: Coding
  /** Unix seconds. */
  readonly startSeconds: number
  /** Unix seconds, never before `startSeconds`. */
  readonly endSeconds: number
}

/** The Observation one {@link Activity} becomes. */
interface Observation {
  readonly resourceType: 'Observation'
  readonly status: 'final'
  readonly category: ReadonlyArray<{ readonly coding: ReadonlyArray<Coding> }>
  readonly code: { readonly coding: ReadonlyArray<Coding> }
  readonly subject: { readonly reference: string }
  readonly effectivePeriod: { readonly start: string; readonly end: string }
  readonly valueCodeableConcept: { readonly coding: ReadonlyArray<Coding> }
  readonly device: { readonly display: string }
}

/**
 * Decodes one activity message from the watch — `ActivityType` (a
 * `HealthActivity` value), `ActivityStart` and `ActivityEnd` (Unix seconds).
 * Throws on an unknown activity, an end before the start, or a payload that
 * isn't that shape.
 *
 * @param payload - The AppMessage payload, keyed by message key name
 */
const decodeMessage = (payload: unknown): Activity => {
  const fields = requirePayload(payload)
  const activityType = requireInteger(fields, 'ActivityType')
  const coding = Object.prototype.hasOwnProperty.call(ACTIVITY_CODINGS, activityType)
    ? ACTIVITY_CODINGS[activityType]
    : undefined
  if (coding === undefined) {
    throw new Error(`Unknown HealthActivity ${activityType}`)
  }
  const startSeconds = requireInteger(fields, 'ActivityStart')
  const endSeconds = requireInteger(fields, 'ActivityEnd')
  if (endSeconds < startSeconds) {
    throw new Error('Activity ends before it starts')
  }
  return { coding, startSeconds, endSeconds }
}

/**
 * Decodes the message ending the watch's sync, whose `ActivityCount` is how
 * many activity messages it sent before it.
 *
 * @param payload - The AppMessage payload, keyed by message key name
 */
const decodeCount = (payload: unknown): number => {
  const count = requireInteger(requirePayload(payload), 'ActivityCount')
  if (count < 0) {
    throw new Error('Message field ActivityCount must not be negative')
  }
  return count
}

/** Unix seconds as a FHIR dateTime in UTC. */
const toDateTime = (seconds: number): string => new Date(seconds * 1000).toISOString()

/**
 * The Observation recording `activity` for the patient `patientId`, made by the
 * watch `watchDisplay` names.
 *
 * @param watchDisplay - `WatchDevice.describe`'s text
 */
const toObservation = (
  activity: Activity,
  patientId: string,
  watchDisplay: string
): Observation => ({
  resourceType: 'Observation',
  status: 'final',
  category: [{ coding: [ACTIVITY_CATEGORY_CODING] }],
  code: { coding: [HEALTH_ACTIVITY_CODING] },
  subject: { reference: `Patient/${patientId}` },
  effectivePeriod: {
    start: toDateTime(activity.startSeconds),
    end: toDateTime(activity.endSeconds),
  },
  valueCodeableConcept: { coding: [activity.coding] },
  device: { display: watchDisplay },
})

export {
  ACTIVITY_CATEGORY_CODING,
  decodeCount,
  decodeMessage,
  HEALTH_SERVICE_SYSTEM,
  toDateTime,
  toObservation,
}
export type { Activity, Coding, Observation }
