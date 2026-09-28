import { isFields, requireInteger, requirePayload } from './fields.ts'
import * as HealthActivity from './health-activity.ts'
import * as MinuteHistory from './minute-history.ts'
import type { Reference } from './watch-device.ts'

/**
 * One Sync Now run as the phone receives it: the watch's messages in, one FHIR
 * transaction Bundle and the watch's answer out.
 *
 * @remarks
 * A namespace module — consumers speak `WatchSync.Type`,
 * `WatchSync.messageKind`, `WatchSync.start`, `WatchSync.withActivity`,
 * `WatchSync.requireComplete`, `WatchSync.toTransactionBundle`,
 * `WatchSync.toResultMessage`. The watch sends `SyncStart` first, carrying the
 * sync's id, then one message per activity, then one per hour of minute
 * history, then one carrying `ActivityCount` and `MinuteHourCount`, how many of
 * each preceded it; see `apps/fhir-sync-pebble/src/c/sync.h` for that side.
 * The phone starts a fresh {@link Type} on `SyncStart` ({@link start}), so
 * whatever an abandoned sync left behind never reaches the next one, collects
 * the rest into it, checks it against those counts ({@link requireComplete}),
 * PUTs its Observations as one transaction and answers with the sync's id
 * ({@link toResultMessage}), so the watch can tell its answer from a late one
 * to a sync it gave up on.
 *
 * @packageDocumentation
 */

/** What the watch has sent of a sync so far, in the order it arrived. */
interface Type {
  /** The id the watch gave the sync in `SyncStart`. */
  readonly syncId: number
  readonly activities: ReadonlyArray<HealthActivity.Activity>
  readonly hours: ReadonlyArray<MinuteHistory.Hour>
  /** Set once one of its messages failed to decode, which fails the whole sync. */
  readonly undecodable: boolean
}

/** Which of the sync's messages a payload is, by the message key only that one carries. */
type MessageKind = 'Start' | 'Activity' | 'MinuteHour' | 'End'

/** An Observation of either kind a sync posts. */
type Observation = HealthActivity.Observation | MinuteHistory.Observation

/** A transaction Bundle writing each Observation under its own id. */
interface TransactionBundle {
  readonly resourceType: 'Bundle'
  readonly type: 'transaction'
  readonly entry: ReadonlyArray<{
    readonly resource: Observation
    /** `url` is `Observation/<the resource's id>`. */
    readonly request: { readonly method: 'PUT'; readonly url: string }
  }>
}

/** The phone's answer to the watch, keyed by `messageKeys` name. */
interface ResultMessage {
  /** 1 when the server stored every Observation, else 0. */
  readonly SyncSucceeded: 0 | 1
  /** The id of the sync it answers. */
  readonly SyncId: number
}

/**
 * Which of the sync's messages `payload` is, or null when it is none of them,
 * not being an object at all included. The start is told by `SyncStart`, an
 * activity message by `ActivityType`, an hour by `MinuteHourStart`, and the one
 * ending the sync by `ActivityCount`, in that order of precedence.
 *
 * @param payload - The AppMessage payload, keyed by message key name
 */
const messageKind = (payload: unknown): MessageKind | null => {
  if (!isFields(payload)) {
    return null
  }
  if ('SyncStart' in payload) {
    return 'Start'
  }
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

/**
 * The sync `startPayload` starts, holding nothing yet: `SyncStart`, the id
 * the watch gave it. Throws when that is not an integer.
 *
 * @param startPayload - The AppMessage payload {@link messageKind} calls `Start`
 */
const start = (startPayload: unknown): Type => ({
  syncId: requireInteger(requirePayload(startPayload), 'SyncStart'),
  activities: [],
  hours: [],
  undecodable: false,
})

/** `sync` with `activity` arrived after what it holds. */
const withActivity = (sync: Type, activity: HealthActivity.Activity): Type => ({
  ...sync,
  activities: [...sync.activities, activity],
})

/** `sync` with `hour` arrived after what it holds. */
const withHour = (sync: Type, hour: MinuteHistory.Hour): Type => ({
  ...sync,
  hours: [...sync.hours, hour],
})

/** `sync` once one of its messages failed to decode. */
const asUndecodable = (sync: Type): Type => ({ ...sync, undecodable: true })

/**
 * `sync` once the message ending it, `endPayload`, confirms every activity and
 * hour arrived. Throws when that message doesn't decode, when its counts differ
 * from what `sync` holds, or when one of `sync`'s messages failed to decode.
 *
 * @param endPayload - The AppMessage payload {@link messageKind} calls `End`
 */
const requireComplete = (sync: Type, endPayload: unknown): Type => {
  const activityCount = HealthActivity.decodeCount(endPayload)
  const hourCount = MinuteHistory.decodeHourCount(endPayload)
  if (
    sync.undecodable ||
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
 * @param device - `WatchDevice.toReference`'s reference
 */
const toObservations = (sync: Type, patientId: string, device: Reference): Array<Observation> => {
  const activityObservations: Array<Observation> = sync.activities.map((activity) =>
    HealthActivity.toObservation(activity, patientId, device)
  )
  return sync.hours.reduce(
    (observations, hour) =>
      observations.concat(MinuteHistory.toObservations(hour, patientId, device)),
    activityObservations
  )
}

/**
 * A transaction Bundle writing every Observation, of either kind, with a PUT to
 * its id: the server stores all of them or none, and one sent again replaces
 * what the same watch sent before rather than adding a copy.
 */
const toTransactionBundle = (observations: ReadonlyArray<Observation>): TransactionBundle => ({
  resourceType: 'Bundle',
  type: 'transaction',
  entry: observations.map((observation) => ({
    resource: observation,
    request: { method: 'PUT', url: `Observation/${observation.id}` },
  })),
})

/** The answer to the sync `syncId`: whether the server stored it all. */
const toResultMessage = (syncId: number, succeeded: boolean): ResultMessage => ({
  SyncSucceeded: succeeded ? 1 : 0,
  SyncId: syncId,
})

export {
  asUndecodable,
  isEmpty,
  messageKind,
  requireComplete,
  start,
  toObservations,
  toResultMessage,
  toTransactionBundle,
  withActivity,
  withHour,
}
export type { MessageKind, Observation, ResultMessage, TransactionBundle, Type }
