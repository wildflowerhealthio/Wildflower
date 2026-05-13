import type { CollectorHttpApiClient } from 'collector-core/clients'
import { Effect, type Scope } from 'effect'
import { useCallback } from 'react'

import { useCollectorClientLayer } from './use-collector-client-layer.ts'

type CollectorEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, CollectorHttpApiClient | Scope.Scope>
) => Promise<A>

/**
 * Returns a runner — a `<A, E>(effect) => Promise<A>` — for one-off
 * effect executions outside the Suspense flow (button-click handlers
 * that await a write, for example). The runner auto-provides the
 * slice's client layer, `BearerToken`, and `webHttpClientLayer`.
 *
 * @example
 * ```ts
 * const run = useCollectorEffectRunner()
 *
 * const deleteRemote = async (id: string): Promise<void> => {
 *   await run(
 *     Effect.flatMap(CollectorHttpApiClient, (c) =>
 *       c['collector-remotes'].DeleteRemote({ path: { id } })
 *     )
 *   )
 * }
 * ```
 */
const useCollectorEffectRunner = (): CollectorEffectRunner => {
  const clientLayer = useCollectorClientLayer()

  return useCallback(
    (effect) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(clientLayer),
          // The provided effect may still require a `Scope` (HttpApiClient
          // endpoints scope their request lifecycles). `Effect.scoped` opens
          // a transient scope that closes when the effect settles.
          Effect.scoped
        )
      ),
    [clientLayer]
  )
}

export { useCollectorEffectRunner }
export type { CollectorEffectRunner }
