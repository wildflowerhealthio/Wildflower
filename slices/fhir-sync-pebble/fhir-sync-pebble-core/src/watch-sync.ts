import type { Fields } from './fields.ts'
import * as HealthActivity from './health-activity.ts'
import * as MinuteHistory from './minute-history.ts'

/**
 * One Sync Now run as the phone receives it: the watch's messages in, one FHIR
 * transaction Bundle out.
 *
 * @remarks
 * A namespace module — consumers speak `WatchSync.Type`,
 * `WatchSync.messageKind`, `WatchSync.withActivity`,
 * `WatchSync.requireComplete`, `WatchSync.toTransactionBundle`. The watch sends
 * one message per activity, then one per hour of minute history, then one
 * carrying `ActivityCount` and `MinuteHourCount`, how many of each preceded it;
 * see `apps/fhir-sync-pebble/src/c/sync.h` for that side. The phone collects
 * them into a {@link Type}, checks it against those counts
 * ({@link requireComplete}), and posts its Observations as one transaction.
 *
 * @packageDocumentation
 */

/** What the watch has sent of a sync so far, in the order it arrived. */
interface Type {
  readonly activities: ReadonlyArray<HealthActivity.Activity>
  readonly hours: ReadonlyArray<MinuteHistory.Hour>
}

/** Which of the sync's messages a payload is, by the message key only that one carries. */
type MessageKind = 'Activity' | 'MinuteHour' | 'End'

/** An Observation of either kind a sync posts. */
type Observation = HealthActivity.Observation | MinuteHistory.Observation

/** A transaction Bundle creating each Observation. */
interface TransactionBundle {
  readonly resourceType: 'Bundle'
  readonly type: 'transaction'
  readonly entry: ReadonlyArray<{
    readonly resource: Observation
    readonly request: { readonly method: 'POST'; readonly url: 'Observation' }
  }>
}

/** A sync before any message arrived. */
const empty: Type = { activities: [], hours: [] }

/**
 * Which of the sync's messages `payload` is, or null when it is none of them.
 * An activity message is told by `ActivityType`, an hour by `MinuteHourStart`,
 * and the one ending the sync by `ActivityCount`.
 *
 * @param payload - The AppMessage payload, keyed by message key name
 */
const messageKind = (payload: Fields): MessageKind | null => {
  if ('ActivityType' in payload) {
    return 'Activity'
  }
  if ('MinuteHourStart' in payload) {
    return 'MinuteHour'
  }
  if ('ActivityCount' in payload) {
    return 'End'
  }
  return null
}

/** `sync` with `activity` arrived after what it holds. */
const withActivity = (sync: Type, activity: HealthActivity.Activity): Type => ({
  activities: [...sync.activities, activity],
  hours: sync.hours,
})

/** `sync` with `hour` arrived after what it holds. */
const withHour = (sync: Type, hour: MinuteHistory.Hour): Type => ({
  activities: sync.activities,
  hours: [...sync.hours, hour],
})

/**
 * `sync` once the message ending it, `endPayload`, confirms every activity and
 * hour arrived. Throws when that message doesn't decode, when its counts differ
 * from what `sync` holds, or when `sync` is null, which stands for a sync one
 * of whose messages failed to decode.
 *
 * @param endPayload - The AppMessage payload {@link messageKind} calls `End`
 */
const requireComplete = (sync: Type | null, endPayload: Fields): Type => {
  const activityCount = HealthActivity.decodeCount(endPayload)
  const hourCount = MinuteHistory.decodeHourCount(endPayload)
  if (
    sync === null ||
    sync.activities.length !== activityCount ||
    sync.hours.length !== hourCount
  ) {
    throw new Error('The watch sent messages that did not all arrive')
  }
  return sync
}

/** Whether `sync` holds nothing to post. */
const isEmpty = (sync: Type): boolean => sync.activities.length === 0 && sync.hours.length === 0

/**
 * Every Observation `sync` records for the patient `patientId`: the activities
 * first, then each hour's, in the order they arrived.
 *
 * @param watchDisplay - `WatchDevice.describe`'s text
 */
const toObservations = (
  sync: Type,
  patientId: string,
  watchDisplay: string
): Array<Observation> => {
  const activityObservations: Array<Observation> = sync.activities.map((activity) =>
    HealthActivity.toObservation(activity, patientId, watchDisplay)
  )
  return sync.hours.reduce(
    (observations, hour) =>
      observations.concat(MinuteHistory.toObservations(hour, patientId, watchDisplay)),
    activityObservations
  )
}

/**
 * A transaction Bundle creating every Observation, of either kind: the server
 * stores all of them or none.
 */
const toTransactionBundle = (observations: ReadonlyArray<Observation>): TransactionBundle => ({
  resourceType: 'Bundle',
  type: 'transaction',
  entry: observations.map((observation) => ({
    resource: observation,
    request: { method: 'POST', url: 'Observation' },
  })),
})

export {
  empty,
  isEmpty,
  messageKind,
  requireComplete,
  toObservations,
  toTransactionBundle,
  withActivity,
  withHour,
}
export type { MessageKind, Observation, TransactionBundle, Type }
