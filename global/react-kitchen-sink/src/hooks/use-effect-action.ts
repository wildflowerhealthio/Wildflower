import { Effect, type Layer, type Scope } from 'effect'
import { useCallback } from 'react'

type EffectAction<R> = <A, E>(effect: Effect.Effect<A, E, R | Scope.Scope>) => Promise<A>

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
const useEffectAction = <R>(layer: Layer.Layer<R, never, never>): EffectAction<R> =>
  useCallback(
    (effect) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped)),
    [layer]
  )

export { useEffectAction }
export type { EffectAction }
