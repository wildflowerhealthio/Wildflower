import { Cause, Effect, Exit, Scope, Stream } from 'effect'

import { expectStreamStart } from './expect-stream-start.ts'
import type { Intent, LifecycleEvent } from './types.ts'

interface ExecuteIntentsOpts<TConfig, TStatus, E> {
  readonly startProcess: (config: TConfig) => Stream.Stream<TStatus, E, Scope.Scope>
}

const startProcessStream = <TConfig, TStatus, E>(
  config: TConfig,
  startProcess: (config: TConfig) => Stream.Stream<TStatus, E, Scope.Scope>
): Stream.Stream<LifecycleEvent<TConfig, TStatus, E>> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      // `acquireRelease` ties the per-process scope's lifetime to the
      // surrounding `unwrapScoped` scope (which is the resulting stream's
      // lifetime). When the outer `Stream.flatMap(..., { switch: true })`
      // interrupts this inner stream on the next intent, the scope is
      // closed atomically — even if interruption fires before the
      // consumer has pulled a single value.
      const scope = yield* Effect.acquireRelease(Scope.make(), (s) => Scope.close(s, Exit.void))
      const startupResult = yield* expectStreamStart(startProcess(config), scope)
      if (startupResult._tag !== 'Started') {
        return Stream.succeed<LifecycleEvent<TConfig, TStatus, E>>({
          _tag: 'Failed',
          config,
          cause: startupResult.cause,
        })
      }
      const firstLifecycleEvent: LifecycleEvent<TConfig, TStatus, E> = {
        _tag: 'Running',
        config,
        status: startupResult.status,
      }
      const lifecycleStream: Stream.Stream<LifecycleEvent<TConfig, TStatus, E>> =
        startupResult.statusStream.pipe(
          Stream.map<TStatus, LifecycleEvent<TConfig, TStatus, E>>((status) => ({
            _tag: 'Running',
            config,
            status,
          })),
          Stream.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? Stream.empty
              : Stream.succeed<LifecycleEvent<TConfig, TStatus, E>>({
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
 * tail's `catchAllCause` sees `Cause.isInterruptedOnly` and emits
 * nothing, and the scope finalizer fires — exactly the
 * SynchronizedRef-guarded "transition supersedes in-flight tail" logic
 * the old daemon spelled out by hand.
 */
const executeIntents =
  <TConfig, TStatus, E>(opts: ExecuteIntentsOpts<TConfig, TStatus, E>) =>
  (intents: Stream.Stream<Intent<TConfig>>): Stream.Stream<LifecycleEvent<TConfig, TStatus, E>> =>
    intents.pipe(
      Stream.flatMap(
        (intent) =>
          intent._tag === 'Stop'
            ? Stream.succeed<LifecycleEvent<TConfig, TStatus, E>>({ _tag: 'Idle' })
            : startProcessStream(intent.config, opts.startProcess),
        { switch: true }
      )
    )

export { executeIntents }
export type { ExecuteIntentsOpts }
