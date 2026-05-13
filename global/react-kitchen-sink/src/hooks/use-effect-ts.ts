import {
  Cause,
  Chunk,
  Effect,
  Exit,
  Fiber,
  type Layer,
  type ManagedRuntime,
  type Scope,
  pipe,
} from 'effect'
import { useEffect, useMemo } from 'react'

import { useStatePromise } from './use-state-promise.ts'

const isManagedRuntime = <R>(
  v: Layer.Layer<R, never, never> | ManagedRuntime.ManagedRuntime<R, never>
): v is ManagedRuntime.ManagedRuntime<R, never> =>
  'runFork' in v && typeof (v as { readonly runFork: unknown }).runFork === 'function'

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
 * Pass a `Layer` (preferred) or a `ManagedRuntime` to run effects
 * whose context requires services beyond `Scope`. With a `Layer` the
 * hook applies `Effect.provide(layer)` internally; with a runtime it
 * delegates to `runtime.runFork`. Without either, `R` must extend
 * only `Scope`.
 */
function useEffectTs<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A>
function useEffectTs<A, E, R>(
  effect: Effect.Effect<A, E, R | Scope.Scope>,
  layer: Layer.Layer<R, never, never>
): Promise<A>
function useEffectTs<A, E, R>(
  effect: Effect.Effect<A, E, R | Scope.Scope>,
  runtime: ManagedRuntime.ManagedRuntime<R, never>
): Promise<A>
function useEffectTs<A, E, R>(
  effect: Effect.Effect<A, E, R | Scope.Scope>,
  layerOrRuntime?: Layer.Layer<R, never, never> | ManagedRuntime.ManagedRuntime<R, never>
): Promise<A> {
  const [promise, { resolve, reject, reset }] = useStatePromise<A>()

  const layer =
    layerOrRuntime !== undefined && !isManagedRuntime(layerOrRuntime) ? layerOrRuntime : undefined
  const runtime =
    layerOrRuntime !== undefined && isManagedRuntime(layerOrRuntime) ? layerOrRuntime : undefined

  const provided = useMemo(() => {
    if (layer === undefined) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- caller without a layer/runtime promised R extends Scope only
      return effect as Effect.Effect<A, E, Scope.Scope>
    }
    return Effect.provide(effect, layer)
  }, [effect, layer])

  useEffect(() => {
    let fiber: Fiber.RuntimeFiber<A, E>
    if (runtime === undefined) {
      fiber = Effect.runFork(provided.pipe(Effect.scoped))
    } else {
      fiber = runtime.runFork(effect.pipe(Effect.scoped))
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
  }, [effect, provided, runtime, resolve, reject, reset])

  return promise
}

export { useEffectTs }
