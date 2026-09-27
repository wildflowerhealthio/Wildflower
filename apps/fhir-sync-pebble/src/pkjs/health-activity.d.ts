// Types for health-activity.js: its JSDoc and test/health-activity.test.ts
// read them. The Pebble bundle only picks up *.js and *.json, so this file
// never reaches the phone.

interface Coding {
  readonly system: string
  readonly code: string
  readonly display: string
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
interface ActivityObservation {
  readonly resourceType: 'Observation'
  readonly status: 'final'
  readonly category: ReadonlyArray<{ readonly coding: ReadonlyArray<Coding> }>
  readonly code: { readonly coding: ReadonlyArray<Coding> }
  readonly subject: { readonly reference: string }
  readonly effectivePeriod: { readonly start: string; readonly end: string }
  readonly valueCodeableConcept: { readonly coding: ReadonlyArray<Coding> }
  readonly device: { readonly display: string }
}

interface TransactionBundle {
  readonly resourceType: 'Bundle'
  readonly type: 'transaction'
  readonly entry: ReadonlyArray<{
    readonly resource: ActivityObservation
    readonly request: { readonly method: 'POST'; readonly url: 'Observation' }
  }>
}

declare const HEALTH_SERVICE_SYSTEM: string
declare function decodeActivityCount(payload: object): number
declare function decodeActivityMessage(payload: object): Activity
declare function describeWatch(watchInfo: unknown): string
declare function toObservation(
  activity: Activity,
  patientId: string,
  watchDisplay: string
): ActivityObservation
declare function toTransactionBundle(
  observations: ReadonlyArray<ActivityObservation>
): TransactionBundle

export {
  decodeActivityCount,
  decodeActivityMessage,
  describeWatch,
  HEALTH_SERVICE_SYSTEM,
  toObservation,
  toTransactionBundle,
}
export type { Activity, ActivityObservation, Coding, TransactionBundle }
