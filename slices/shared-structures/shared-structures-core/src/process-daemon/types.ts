import type { Cause } from 'effect'

/**
 * Projection of a livestore row down to the user-controlled fields that
 * drive the daemon: whether the user has requested the process to run,
 * and the (possibly null) config to run it with.
 *
 * @typeParam TConfig - Slice-specific config payload. Should be a shallow
 *   object (or `null`); `watchSnapshots` wraps it in `Data.struct` so
 *   structural equality powers the upstream `Stream.changes` dedup.
 */
interface ControlSnapshot<TConfig> {
  readonly requestedRunning: boolean
  readonly config: TConfig | null
}

/**
 * The transition implied by moving from one `ControlSnapshot` to the
 * next.
 *
 * `diffIntents` filters out the "no transition" case (initial inactive
 * snapshot, or any pair of snapshots that both describe inactivity)
 * before exposing the intent stream, so `executeIntents` only sees
 * actionable transitions.
 *
 * @typeParam TConfig - Slice-specific config payload carried on
 *   `StartOrReconfigure`.
 */
type Intent<TConfig> =
  | { readonly _tag: 'StartOrReconfigure'; readonly config: TConfig }
  | { readonly _tag: 'Stop' }

/**
 * The process is running with the given config and most-recent status.
 * Emitted once per `startProcess` stream emit — the first carries the
 * initial bind signal; subsequent ones carry status updates from the
 * same `startProcess` invocation (e.g. a tunnel relay re-binding to a
 * new subdomain).
 */
type Running<TConfig, TStatus> = {
  readonly _tag: 'Running'
  readonly config: TConfig
  readonly status: TStatus
}

/**
 * The process has been stopped (either by an explicit Stop intent
 * or by the row's `requestedRunning` flipping to false).
 */
type Idle = { readonly _tag: 'Idle' }

/**
 * `startProcess` either failed before emitting (pre-bind) or its tail
 * failed terminally (post-bind, non-interrupted). Caller commits the
 * error to livestore. The daemon's own error commit must not change
 * the snapshot projection — otherwise it would re-enter
 * `executeIntents` and busy-retry.
 */
type Failed<TConfig, TError> = {
  readonly _tag: 'Failed'
  readonly config: TConfig
  readonly cause: Cause.Cause<TError>
}

/**
 * Events surfaced by the execute stage. The slice attaches its
 * livestore commits to these via `Stream.runForEach`.
 *
 * @typeParam TConfig - Slice-specific config payload.
 * @typeParam TStatus - Status payload emitted by `startProcess` after the
 *   initial bind signal.
 * @typeParam TError - Error channel of `startProcess`.
 */
type LifecycleEvent<TConfig, TStatus, TError> =
  | Running<TConfig, TStatus>
  | Idle
  | Failed<TConfig, TError>

export type { Intent, LifecycleEvent, ControlSnapshot }
