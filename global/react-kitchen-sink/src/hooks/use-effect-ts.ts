import { Cause, Chunk, Effect, Exit, Fiber, type ManagedRuntime, type Scope, pipe } from 'effect'
import { useEffect } from 'react'

import { useStatePromise } from './use-state-promise.ts'

/**
 * Runs a scoped `Effect<A, E>` and returns a `Promise<A>` that
 * tracks its result. Suitable for `use()` (React Suspense).
 *
 * @remarks
 * The effect is forked into an unmanaged fiber on mount. The fiber's
 * exit is observed and mapped to promise settlement:
 *
 * - **Success** resolves the promise.
 * - **Pure interruption** (`Cause.isInterruptedOnly`) is silently
 *   ignored — this is the normal cleanup path when `effect` changes
 *   or the component unmounts.
 * - **Single failure** rejects with the error value directly.
 * - **Multiple failures or defects** reject with an `AggregateError`.
 *
 * On cleanup the fiber is interrupted and the promise is reset to
 * pending, ready for the next effect.
 *
 * Pass a `ManagedRuntime` to run effects whose context requires
 * services beyond `Scope` (e.g. an HTTP client or app-specific
 * tags). Without it, `R` must extend only `Scope`.
 */
function useEffectTs<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A>
function useEffectTs<A, E, R>(
  effect: Effect.Effect<A, E, R | Scope.Scope>,
  runtime: ManagedRuntime.ManagedRuntime<R, never>
): Promise<A>
function useEffectTs<A, E, R>(
  effect: Effect.Effect<A, E, R | Scope.Scope>,
  runtime?: ManagedRuntime.ManagedRuntime<R, never>
): Promise<A> {
  const [promise, { resolve, reject, reset }] = useStatePromise<A>()

  useEffect(() => {
    const scoped = effect.pipe(Effect.scoped)

    let fiber: Fiber.RuntimeFiber<A, E>
    if (runtime === undefined) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This is safe thanks to the type definitions
      const contextFreeEffect = scoped as Effect.Effect<A, E, never>

      fiber = Effect.runFork(contextFreeEffect)
    } else {
      fiber = runtime.runFork(scoped)
    }

    fiber.addObserver(
      Exit.match({
        onSuccess(a) {
          resolve(a)
        },
        onFailure(cause) {
          if (Cause.isInterruptedOnly(cause)) return

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
            Effect.logError('useEffectTs: effect failed with non-actionable cause', cause)
          )
        },
      })
    )

    return (): void => {
      Effect.runFork(pipe(Fiber.interrupt(fiber), Effect.andThen(Effect.sync(reset))))
    }
  }, [effect, runtime, resolve, reject, reset])

  return promise
}

export { useEffectTs }
