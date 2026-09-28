import { isFields, requireInteger, requirePayload } from './fields.ts'
import * as HealthActivity from './health-activity.ts'
import * as MinuteHistory from './minute-history.ts'
import * as PhoneSettings from './phone-settings.ts'
import type { Reference } from './watch-device.ts'

/**
 * One Sync Now run as the phone receives it: the watch's messages in, one FHIR
 * transaction Bundle and the watch's answer out.
 *
 * @remarks
 * A namespace module — consumers speak `WatchSync.Type`, `WatchSync.receive`,
 * `WatchSync.planWrite`, `WatchSync.toResultMessage`. The watch sends
 * `SyncStart` first, carrying the sync's id and the watch's connection id,
 * then one message per activity, then one per hour of minute history, then one
 * carrying `ActivityCount` and `MinuteHourCount`, how many of each preceded it;
 * see `apps/fhir-sync-pebble/src/c/sync.h` for that side.
 *
 * The phone folds each message into the sync under way with {@link receive},
 * a reducer from the sync under way (null for none) and a message to the next
 * and what to do. It starts a fresh {@link Type} on `SyncStart`, so whatever an
 * abandoned sync left behind never reaches the next one, collects the rest into
 * it and checks it against those counts. {@link planWrite} then checks that
 * the watch's connection is the one the phone holds and builds the transaction
 * that PUTs its Observations, and the phone answers with the sync's id
 * ({@link toResultMessage}), so the watch can tell its answer from a late one
 * to a sync it gave up on.
 *
 * @packageDocumentation
 */

/** What the watch has sent of a sync so far, in the order it arrived. */
interface Type {
  /** The id the watch gave the sync in `SyncStart`. */
  readonly syncId: number
  /**
   * The connection the watch's last-sync times belong to, which `SyncStart`
   * carries: `PhoneSettings.connectionId` of the settings it last received.
   */
  readonly connectionId: string
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
 * What the phone does after {@link receive} folds in a message:
 *
 * - `Continue` — nothing; the message joined the sync, or wasn't a sync's;
 * - `Drop` — log `reason`; the message was dropped, or failed the sync under
 *   way (which then fails at its end), and nothing is answered now;
 * - `Fail` — answer the sync `syncId` with failure, logging `reason`;
 * - `Write` — the sync is complete: write it ({@link planWrite}) and answer
 *   with whether the server stored it.
 */
type Action =
  | { readonly _tag: 'Continue' }
  | { readonly _tag: 'Drop'; readonly reason: string }
  | { readonly _tag: 'Fail'; readonly syncId: number; readonly reason: string }
  | { readonly _tag: 'Write'; readonly sync: Type }

/** The sync under way after a message, null for none, and what to do about the message. */
interface Step {
  readonly pending: Type | null
  readonly action: Action
}

/**
 * How to write a complete sync to the server the phone's settings name:
 *
 * - `WrongConnection` — the watch's last-sync times belong to another patient
 *   or server than the settings do (the settings never reached the watch, or
 *   changed mid-sync), so writing would mark the wrong record synced: answer
 *   failure and send the watch its settings again;
 * - `Nothing` — nothing to write: answer success without a request;
 * - `Transaction` — PUT `bundle` to the FHIR base URL.
 */
type WritePlan =
  | { readonly _tag: 'WrongConnection' }
  | { readonly _tag: 'Nothing' }
  | { readonly _tag: 'Transaction'; readonly bundle: TransactionBundle }

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
 * the watch gave it, and `ConnectionId`, the watch's connection. Throws when
 * the id is not an integer or the connection not a string.
 *
 * @param startPayload - The AppMessage payload {@link messageKind} calls `Start`
 */
const start = (startPayload: unknown): Type => {
  const fields = requirePayload(startPayload)
  const connectionId = fields['ConnectionId']
  if (typeof connectionId !== 'string') {
    throw new Error('Message field ConnectionId must be a string')
  }
  return {
    syncId: requireInteger(fields, 'SyncStart'),
    connectionId,
    activities: [],
    hours: [],
    undecodable: false,
  }
}

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

/** `sync` with `add` applied, or marked undecodable, with the reason, when it throws. */
const addDecoded = (sync: Type, add: (sync: Type) => Type): Step => {
  try {
    return { pending: add(sync), action: { _tag: 'Continue' } }
  } catch (error) {
    return {
      pending: asUndecodable(sync),
      action: { _tag: 'Drop', reason: `Failing sync ${sync.syncId}: ${String(error)}` },
    }
  }
}

/**
 * Folds the AppMessage `payload` into `pending`, the sync under way (null for
 * none): the sync after it, and what to do.
 *
 * `SyncStart` replaces whatever is under way; a start that doesn't decode
 * leaves none. An activity or hour joins the sync under way, or marks it
 * undecodable; with none under way it is dropped. The end takes the sync out
 * of `pending` and writes it when complete ({@link requireComplete}), else
 * fails it; with none under way there is no id to answer, so it is dropped and
 * the watch's own timeout ends its sync. Any other message is left alone.
 */
const receive = (pending: Type | null, payload: unknown): Step => {
  const kind = messageKind(payload)
  if (kind === null) {
    return { pending, action: { _tag: 'Continue' } }
  }
  if (kind === 'Start') {
    try {
      return { pending: start(payload), action: { _tag: 'Continue' } }
    } catch (error) {
      return {
        pending: null,
        action: { _tag: 'Drop', reason: `Dropping a sync: ${String(error)}` },
      }
    }
  }
  if (pending === null) {
    return {
      pending,
      action: { _tag: 'Drop', reason: `Dropping a ${kind} message that arrived outside a sync` },
    }
  }
  if (kind === 'Activity') {
    return addDecoded(pending, (sync) => withActivity(sync, HealthActivity.decodeMessage(payload)))
  }
  if (kind === 'MinuteHour') {
    return addDecoded(pending, (sync) => withHour(sync, MinuteHistory.decodeHourMessage(payload)))
  }
  try {
    return { pending: null, action: { _tag: 'Write', sync: requireComplete(pending, payload) } }
  } catch (error) {
    return {
      pending: null,
      action: { _tag: 'Fail', syncId: pending.syncId, reason: String(error) },
    }
  }
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

/**
 * How to write the complete `sync` for the patient `settings` name
 * ({@link WritePlan}). The connection is checked first, so a sync for another
 * connection fails even with nothing to write.
 *
 * @param readDevice - `WatchDevice.toReference` over the connected watch,
 *   called only when there is something to write; it may throw
 */
const planWrite = (
  sync: Type,
  settings: PhoneSettings.Settings,
  readDevice: () => Reference
): WritePlan => {
  if (sync.connectionId !== PhoneSettings.connectionId(settings)) {
    return { _tag: 'WrongConnection' }
  }
  if (isEmpty(sync)) {
    return { _tag: 'Nothing' }
  }
  const observations = toObservations(sync, settings.patientId, readDevice())
  if (observations.length === 0) {
    return { _tag: 'Nothing' }
  }
  return { _tag: 'Transaction', bundle: toTransactionBundle(observations) }
}

/** The answer to the sync `syncId`: whether the server stored it all. */
const toResultMessage = (syncId: number, succeeded: boolean): ResultMessage => ({
  SyncSucceeded: succeeded ? 1 : 0,
  SyncId: syncId,
})

export {
  asUndecodable,
  isEmpty,
  messageKind,
  planWrite,
  receive,
  requireComplete,
  start,
  toObservations,
  toResultMessage,
  toTransactionBundle,
  withActivity,
  withHour,
}
export type {
  Action,
  MessageKind,
  Observation,
  ResultMessage,
  Step,
  TransactionBundle,
  Type,
  WritePlan,
}
