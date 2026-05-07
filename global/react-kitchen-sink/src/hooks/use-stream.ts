import { Cause, Chunk, Effect, Exit, Fiber, type ManagedRuntime, type Scope, Stream } from 'effect'
import { useEffect } from 'react'

import { useStatePromise } from './use-state-promise.ts'

/**
 * Subscribes to a scoped Effect `Stream<A, E>` and returns a
 * `Promise<A>` that resolves with the latest emitted value. The
 * stream fiber is interrupted on unmount or when the stream
 * reference changes.
 *
 * Pass a `ManagedRuntime` when the stream's context requires
 * services beyond `Scope` (e.g. an HTTP client or app-specific
 * tags). Without it, `R` must extend only `Scope`.
 */
function useStream<A, E>(stream: Stream.Stream<A, E, Scope.Scope>): Promise<A>
function useStream<A, E, R>(
  stream: Stream.Stream<A, E, R | Scope.Scope>,
  runtime: ManagedRuntime.ManagedRuntime<R, never>
): Promise<A>
function useStream<A, E, R>(
  stream: Stream.Stream<A, E, R | Scope.Scope>,
  runtime?: ManagedRuntime.ManagedRuntime<R, never>
): Promise<A> {
  const [promise, { resolve, reject, reset }] = useStatePromise<A>()

  useEffect(() => {
    reset()

    let fiber: Fiber.RuntimeFiber<void, E>
    if (runtime === undefined) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This is safe thanks to the type definitions
      const contextFreeStream = stream as Stream.Stream<A, E, Scope.Scope>
      const s = Stream.runForEach(contextFreeStream, (e) =>
        Effect.sync(() => {
          resolve(e)
        })
      ).pipe(Effect.scoped)
      fiber = Effect.runFork(s)
    } else {
      const s = Stream.runForEach(stream, (e) =>
        Effect.sync(() => {
          resolve(e)
        })
      ).pipe(Effect.scoped)
      fiber = runtime.runFork(s)
    }

    fiber.addObserver(
      Exit.match({
        onSuccess(_) {
          // Stream completed without emitting; nothing to settle.
        },
        onFailure(cause) {
          if (Cause.isInterrupted(cause)) return

          const failures = Chunk.toArray(Cause.failures(cause))
          if (failures.length === 1) {
            void reject(failures[0])
            return
          } else if (failures.length > 1) {
            void reject(new AggregateError(failures, 'Multiple failures occurred'))
            return
          }

          const defects = Chunk.toArray(Cause.defects(cause))
          if (defects.length > 0) {
            void reject(new AggregateError(defects, 'Multiple defects occurred'))
            return
          }

          // Last-resort diagnostic when the cause has neither failures
          // nor defects (e.g. an empty cause from a pathological
          // composition). Routed through Effect's logger so telemetry
          // adapters get the breadcrumb instead of a raw console call.
          Effect.runFork(
            Effect.logError('useStream: stream failed with non-actionable cause', cause)
          )
        },
      })
    )

    return (): void => {
      void Effect.runPromise(Fiber.interrupt(fiber))
    }
  }, [reject, reset, resolve, stream, runtime])

  return promise
}

export { useStream }
