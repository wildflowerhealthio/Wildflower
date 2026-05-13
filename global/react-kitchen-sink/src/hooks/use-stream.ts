import { Cause, Chunk, Effect, Exit, Fiber, type Layer, type Scope, Stream } from 'effect'
import { useEffect, useMemo, useState } from 'react'

import { useStatePromise } from './use-state-promise.ts'

const useStreamWithCallbacks = <A, E>(
  contextFreeStream: Stream.Stream<A, E, Scope.Scope>,
  {
    resolve,
    reject,
    reset,
  }: {
    resolve: (a: A) => void
    reject: (e: E | AggregateError) => Promise<void>
    reset: () => void
  }
): void => {
  useEffect(() => {
    reset()

    const s = Stream.runForEach(contextFreeStream, (e) =>
      Effect.sync(() => {
        resolve(e)
      })
    ).pipe(Effect.scoped)
    const fiber = Effect.runFork(s)

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
  }, [reject, reset, resolve, contextFreeStream])
}

/**
 * Subscribes to a scoped Effect `Stream<A, E>` and returns a
 * `Promise<A>` that resolves with the latest emitted value. The
 * stream fiber is interrupted on unmount or when the stream
 * reference changes.
 *
 * Pass a `Layer` when the stream's context requires services beyond
 * `Scope`. The hook applies `Stream.provideLayer(layer)` internally.
 * Without one, `R` must extend only `Scope`.
 */
function useStream<A, E>(stream: Stream.Stream<A, E, Scope.Scope>): Promise<A>
function useStream<A, E, R>(
  stream: Stream.Stream<A, E, R | Scope.Scope>,
  layer: Layer.Layer<R, never, never>
): Promise<A>
function useStream<A, E, R>(
  stream: Stream.Stream<A, E, R | Scope.Scope>,
  layer?: Layer.Layer<R, never, never>
): Promise<A> {
  const [promise, { resolve, reject, reset }] = useStatePromise<A>()

  const provided = useMemo(() => {
    if (layer === undefined) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- caller without a layer promised R extends Scope only
      return stream as Stream.Stream<A, E, Scope.Scope>
    }
    return stream.pipe(Stream.provideSomeLayer(layer))
  }, [stream, layer])

  useStreamWithCallbacks(provided, { reset, resolve, reject })

  return promise
}

const useStreamWithDefault = <A>(stream: Stream.Stream<A, never, Scope.Scope>, defaultA: A): A => {
  const [lastValue, setLastValue] = useState<A>(defaultA)
  useStreamWithCallbacks(stream, {
    reset: () => setLastValue(defaultA),
    resolve: (emitted) => setLastValue(emitted),
    reject: (err) => {
      setLastValue(defaultA)
      return Promise.reject(err)
    },
  })
  return lastValue
}

export { useStream, useStreamWithDefault }
