import 'kitchen-sink/polyfills/promise-with-resolvers'

import { Cause, Chunk, Effect, Exit, Fiber, type Layer, type Scope } from 'effect'
import { useCallback, useEffect, useRef } from 'react'

type EffectAction<R> = <A, E>(effect: Effect.Effect<A, E, R | Scope.Scope>) => Promise<A>

interface UseEffectActionOptions {
  /**
   * When `true`, every in-flight fiber spawned by the returned runner
   * is tracked and interrupted when the host component unmounts.
   *
   * Use for read-only fetches where a stale tab no longer needs the
   * result. Leave unset (the default) for writes — a request that has
   * crossed the network should be allowed to commit even if the user
   * navigates away.
   */
  readonly interruptOnUnmount?: boolean
}

/**
 * Returns a memoised runner — a `<A, E>(effect) => Promise<A>` — that
 * runs effects against the supplied {@link Layer} outside the React
 * Suspense flow. Suitable for one-off button-click handlers and other
 * imperative callsites that await a write.
 *
 * The runner closes over the layer reference, so a fresh layer
 * produces a fresh runner (and stable identity within a render's
 * `useMemo` dependency list). Each call opens a transient `Scope`
 * (`Effect.scoped`) so the effect's request-scoped resources release
 * when the promise settles.
 *
 * @remarks
 * The default runner is fire-and-forget: the fiber is **not**
 * interrupted on unmount. A write that has crossed the network will
 * commit even if the user navigates away. Pass
 * `{ interruptOnUnmount: true }` to opt into fiber interruption on
 * cleanup — useful for read-only fetches where a stale tab no longer
 * needs the result.
 *
 * @example
 * ```ts
 * const run = useEffectAction(useGatekeeperClientLayer())
 *
 * const revoke = async (id: string): Promise<void> => {
 *   await run(
 *     Effect.flatMap(GatekeeperHttpApiClient, (c) =>
 *       c['access-management'].RevokeGrant({ path: { id } })
 *     )
 *   )
 * }
 * ```
 */
function useEffectAction<R>(layer: Layer.Layer<R, never, never>): EffectAction<R>
function useEffectAction<R>(
  layer: Layer.Layer<R, never, never>,
  options: { readonly interruptOnUnmount: true }
): EffectAction<R>
function useEffectAction<R>(
  layer: Layer.Layer<R, never, never>,
  options?: UseEffectActionOptions
): EffectAction<R>
function useEffectAction<R>(
  layer: Layer.Layer<R, never, never>,
  options?: UseEffectActionOptions
): EffectAction<R> {
  const interruptOnUnmount = options?.interruptOnUnmount === true

  // Ref-backed set of outstanding fibers; only populated when
  // `interruptOnUnmount` is enabled. Wrapped in a ref so the runner
  // identity remains stable across renders.
  const fibersRef = useRef<Set<Fiber.RuntimeFiber<unknown, unknown>>>(new Set())

  useEffect(() => {
    if (!interruptOnUnmount) {
      return undefined
    }
    const fibers = fibersRef.current
    return (): void => {
      for (const fiber of fibers) {
        Effect.runFork(Fiber.interrupt(fiber))
      }
      fibers.clear()
    }
  }, [interruptOnUnmount])

  const fireAndForget = useCallback<EffectAction<R>>(
    (effect) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped)),
    [layer]
  )

  const tracked = useCallback<EffectAction<R>>(
    <A, E>(effect: Effect.Effect<A, E, R | Scope.Scope>): Promise<A> => {
      const { promise, resolve, reject } = Promise.withResolvers<A>()
      const fiber: Fiber.RuntimeFiber<A, E> = Effect.runFork(
        effect.pipe(Effect.provide(layer), Effect.scoped)
      )
      fibersRef.current.add(fiber)
      fiber.addObserver(
        Exit.match({
          onSuccess(a) {
            fibersRef.current.delete(fiber)
            resolve(a)
          },
          onFailure(cause) {
            fibersRef.current.delete(fiber)
            if (Cause.isInterruptedOnly(cause)) {
              // Component unmounted (or the fiber was otherwise
              // interrupted). Leave the promise unsettled — there is
              // no consumer left to observe a rejection, and a stray
              // unhandled-rejection here would just be noise.
              return
            }
            const failures = Chunk.toArray(Cause.failures(cause))
            if (failures.length === 1) {
              reject(failures[0])
              return
            } else if (failures.length > 1) {
              reject(new AggregateError(failures, 'Multiple failures occurred'))
              return
            }
            const defects = Chunk.toArray(Cause.defects(cause))
            if (defects.length === 1) {
              reject(defects[0])
              return
            } else if (defects.length > 1) {
              reject(new AggregateError(defects, 'Multiple defects occurred'))
              return
            }
            reject(new Error('useEffectAction: effect failed with non-actionable cause'))
          },
        })
      )
      return promise
    },
    [layer]
  )

  if (interruptOnUnmount) {
    return tracked
  }
  return fireAndForget
}

export { useEffectAction }
export type { EffectAction, UseEffectActionOptions }
