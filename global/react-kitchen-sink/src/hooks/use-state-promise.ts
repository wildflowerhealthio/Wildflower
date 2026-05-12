import 'kitchen-sink/polyfills/promise-with-resolvers'

import { useMemo, useRef, useState } from 'react'

interface StatePromiseCallbacks<A> {
  /**
   * Transforms the resolved value, or queues `f` if the promise is
   * still pending.
   */
  readonly map: (f: (a: A) => A) => void
  /**
   * Resolves the promise (applies any queued maps), or replaces an
   * already-settled promise with a new resolved one.
   */
  readonly resolve: (a: A) => void
  /**
   * Rejects similarly. Returns the new promise so callers can attach
   * a `.catch` if they need to swallow the rejection.
   */
  readonly reject: (reason: unknown) => Promise<never>
  /**
   * Replaces a settled promise with a fresh pending one. No-op when
   * the current promise is still pending.
   */
  readonly reset: () => void
}

/**
 * A controllable promise whose resolution can be driven imperatively.
 *
 * Returns a tuple `[promise, callbacks]` where:
 * - `promise` — the current `Promise<A>`, stable until `reset`
 * - `callbacks.resolve(a)` — resolves the promise, applying any queued maps
 * - `callbacks.reject(reason)` — rejects the promise
 * - `callbacks.reset()` — replaces a settled promise with a fresh pending one
 * - `callbacks.map(f)` — transforms the resolved value, or queues `f` if pending
 *
 * @remarks
 * This is the low-level primitive behind {@link useEffectTs} and
 * {@link useStream}. It bridges imperative Effect fiber callbacks into
 * React's Suspense model by exposing a stable `Promise` whose
 * settlement can be driven from outside.
 *
 * The `map` callback composes transformations: if the promise is
 * already resolved, `map` chains `.then(f)` onto it; if still pending,
 * `f` is queued and applied atomically at resolve time. This enables
 * optimistic-update patterns without re-creating the promise identity.
 */
const useStatePromise = <A>(): readonly [Promise<A>, StatePromiseCallbacks<A>] => {
  const resolvedRef = useRef(false)
  const initial = Promise.withResolvers<A>()
  const promiseWithResolversRef = useRef(initial)
  const mappingRef = useRef((a: A): A => a)
  const [promise, setPromise] = useState(initial.promise)

  const callbacks = useMemo<StatePromiseCallbacks<A>>(
    () => ({
      map: (f) => {
        if (resolvedRef.current) {
          setPromise((p) => p.then((a) => f(a)))
        } else {
          const prev = mappingRef.current
          mappingRef.current = (a): A => f(prev(a))
        }
      },
      resolve: (a) => {
        if (resolvedRef.current) {
          promiseWithResolversRef.current = Promise.withResolvers<A>()
          promiseWithResolversRef.current.resolve(a)
          setPromise(promiseWithResolversRef.current.promise)
        } else {
          resolvedRef.current = true
          const mapped = mappingRef.current(a)
          mappingRef.current = (x): A => x
          promiseWithResolversRef.current.resolve(mapped)
        }
      },
      reject: (reason): Promise<never> => {
        if (resolvedRef.current) {
          promiseWithResolversRef.current = Promise.withResolvers<A>()
          promiseWithResolversRef.current.reject(reason)
          setPromise(promiseWithResolversRef.current.promise)
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          return promiseWithResolversRef.current.promise as Promise<never>
        }
        resolvedRef.current = true
        promiseWithResolversRef.current.reject(reason)
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return promiseWithResolversRef.current.promise as Promise<never>
      },
      reset: () => {
        if (!resolvedRef.current) return
        resolvedRef.current = false
        promiseWithResolversRef.current = Promise.withResolvers<A>()
        setPromise(promiseWithResolversRef.current.promise)
      },
    }),
    []
  )

  return [promise, callbacks] as const
}

export { useStatePromise }
export type { StatePromiseCallbacks }
