import { Cause, Effect, Exit, Option, type Scope, Sink, Stream } from 'effect'

import type { Intent, LifecycleEvent } from './types.ts'

/**
 * Options for {@link executeIntents}.
 *
 * @typeParam TConfig - Slice-specific config payload carried on
 *   `StartOrReconfigure` intents.
 * @typeParam TStatus - Status payload type emitted by `startProcess`.
 * @typeParam TError - Error channel of `startProcess`.
 */
interface ExecuteIntentsOpts<TConfig, TStatus, TError> {
  /**
   * Open the underlying process and yield its status stream.
   *
   * The returned stream must observe two contracts:
   *
   * 1. **Bind signal first.** The first emit is the "process is ready"
   *    signal — `executeIntents` peels it via `Stream.peel(_, Sink.head)`
   *    and turns it into the initial `Running` lifecycle event. A stream
   *    that completes without ever emitting is treated as a defect
   *    (surfaced via the `Failed` lifecycle event).
   *
   * 2. **Scope-bound resources.** All resources (sockets, child
   *    processes, watchers) must be acquired in the supplied
   *    `Scope.Scope` — typically via `Effect.acquireRelease`. The daemon
   *    holds one scope per active process; when a new intent supersedes
   *    the in-flight one (`Stream.flatMap` with `switch: true`), the
   *    scope is closed and the producer's finalizers run before the
   *    next process starts. Finalizer failures during this teardown are
   *    swallowed (interrupt-tagged causes don't surface as `Failed`).
   */
  readonly startProcess: (config: TConfig) => Stream.Stream<TStatus, TError, Scope.Scope>
}

const startProcessStream = <TConfig, TStatus, TError>(
  config: TConfig,
  startProcess: (config: TConfig) => Stream.Stream<TStatus, TError, Scope.Scope>
): Stream.Stream<LifecycleEvent<TConfig, TStatus, TError>> =>
  // `unwrapScoped` ties the per-process scope's lifetime to the
  // resulting stream's lifetime. When the outer `Stream.flatMap(...,
  // { switch: true })` interrupts this inner stream on the next intent,
  // the scope is closed atomically — even if interruption fires before
  // the consumer has pulled a single value.
  Stream.unwrapScoped(
    Effect.gen(function* () {
      // `Stream.peel(_, Sink.head)` consumes the first emit as the
      // "bind signal" and hands back the tail stream. It's run as a
      // scoped Effect so the producer's `acquireRelease` resources are
      // bound to the surrounding `unwrapScoped` scope. Wrapping with
      // `Effect.exit` keeps the outer stream's error channel clean —
      // pre-bind failures are surfaced as a `Failed` lifecycle event,
      // not as a stream-level failure.
      const peeled = yield* Effect.exit(Stream.peel(startProcess(config), Sink.head<TStatus>()))
      if (Exit.isFailure(peeled)) {
        return Stream.succeed<LifecycleEvent<TConfig, TStatus, TError>>({
          _tag: 'Failed',
          config,
          cause: peeled.cause,
        })
      }
      const [headOption, tailStream] = peeled.value
      if (Option.isNone(headOption)) {
        // A stream that completes without emitting can't represent a
        // running process. Treat as a defect so the lifecycle surface
        // is exhaustive without adding a third terminal tag.
        return Stream.succeed<LifecycleEvent<TConfig, TStatus, TError>>({
          _tag: 'Failed',
          config,
          cause: Cause.die('startProcess stream ended without emitting a bind signal'),
        })
      }
      const firstLifecycleEvent: LifecycleEvent<TConfig, TStatus, TError> = {
        _tag: 'Running',
        config,
        status: headOption.value,
      }
      const lifecycleStream: Stream.Stream<LifecycleEvent<TConfig, TStatus, TError>> =
        tailStream.pipe(
          Stream.map<TStatus, LifecycleEvent<TConfig, TStatus, TError>>((status) => ({
            _tag: 'Running',
            config,
            status,
          })),
          Stream.catchAllCause((cause) =>
            // `isInterrupted` (any interrupt anywhere in the cause)
            // rather than `isInterruptedOnly`: a producer finalizer that
            // fails during a supersede produces `Interrupt + Die`. We
            // still want the supersede to be silent — the user-visible
            // event is the *next* intent's `Running`, not a stale
            // `Failed` about the one being torn down.
            Cause.isInterrupted(cause)
              ? Stream.empty
              : Stream.succeed<LifecycleEvent<TConfig, TStatus, TError>>({
                  _tag: 'Failed',
                  config,
                  cause,
                })
          )
        )
      return Stream.concat(Stream.succeed(firstLifecycleEvent), lifecycleStream)
    })
  )

/**
 * Stage 3 of the process-daemon pipeline.
 *
 * For each incoming `Intent`, emit the corresponding `LifecycleEvent`s.
 * `Stop` is a single `Idle` emit; `StartOrReconfigure` opens a
 * per-process scope, peels the bind signal, then emits a `Running` for
 * the initial status followed by one `Running` per subsequent
 * status-stream emit and, on terminal failure, a single `Failed`. Tail
 * interruption (the outer `switch` swapping in the next intent) is
 * silent — the per-process scope's finalizer releases the producer's
 * resources.
 *
 * `{ switch: true }` is the key shape constraint: when a new intent
 * arrives mid-tail, the previous inner stream is interrupted, the
 * tail's `catchAllCause` sees `Cause.isInterrupted` and emits nothing,
 * and the scope finalizer fires — exactly the SynchronizedRef-guarded
 * "transition supersedes in-flight tail" logic the old daemon spelled
 * out by hand.
 */
const executeIntents =
  <TConfig, TStatus, TError>(opts: ExecuteIntentsOpts<TConfig, TStatus, TError>) =>
  (
    intents: Stream.Stream<Intent<TConfig>>
  ): Stream.Stream<LifecycleEvent<TConfig, TStatus, TError>> =>
    intents.pipe(
      Stream.flatMap(
        (intent) =>
          intent._tag === 'Stop'
            ? Stream.succeed<LifecycleEvent<TConfig, TStatus, TError>>({ _tag: 'Idle' })
            : startProcessStream(intent.config, opts.startProcess),
        { switch: true }
      )
    )

export { executeIntents }
export type { ExecuteIntentsOpts }
