import type { Cause, Stream } from 'effect'

/**
 * Projection of a livestore row down to the user-controlled fields that
 * drive the daemon: whether the user has requested the process to run,
 * and the (possibly null) config to run it with.
 *
 * `config` should be constructed by the caller as a `Data.struct`
 * (or any value implementing `Effect.Equal`) so the upstream
 * `Stream.changes` deduplication can compare it structurally.
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
type Failed<TConfig, E> = {
  readonly _tag: 'Failed'
  readonly config: TConfig
  readonly cause: Cause.Cause<E>
}

/**
 * Events surfaced by the execute stage. The slice attaches its
 * livestore commits to these via `Stream.runForEach`.
 */
type LifecycleEvent<TConfig, TStatus, E> = Running<TConfig, TStatus> | Idle | Failed<TConfig, E>

/**
 * Result of `expectStreamStart` — the first emit from `startProcess`, plus
 * the rest of the stream; or a typed failure.
 */
type StreamStartResult<TStatus, E> =
  | {
      readonly _tag: 'Started'
      readonly status: TStatus
      readonly statusStream: Stream.Stream<TStatus, E>
    }
  | { readonly _tag: 'Failed'; readonly cause: Cause.Cause<E> }

export type { Intent, LifecycleEvent, StreamStartResult, ControlSnapshot }
