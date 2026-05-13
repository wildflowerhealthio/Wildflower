import type { AppsHttpApiClient } from 'apps-core/clients'
import { Effect, type Scope } from 'effect'
import { useCallback } from 'react'

import { useAppsClientLayer } from './use-apps-client-layer.ts'

type AppsEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, AppsHttpApiClient | Scope.Scope>
) => Promise<A>

/**
 * Returns a runner — a `<A, E>(effect) => Promise<A>` — for one-off
 * effect executions outside the Suspense flow (button-click handlers
 * that await a write, for example). The runner auto-provides the
 * slice's client layer, `BearerToken`, and `webHttpClientLayer`.
 *
 * @example
 * ```ts
 * const run = useAppsEffectRunner()
 *
 * const toggle = async (id: string, enabled: boolean): Promise<void> => {
 *   await run(
 *     Effect.flatMap(AppsHttpApiClient, (c) =>
 *       c.apps.UpdateApp({ path: { id }, payload: { enabled } })
 *     )
 *   )
 * }
 * ```
 */
const useAppsEffectRunner = (): AppsEffectRunner => {
  const clientLayer = useAppsClientLayer()

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

export { useAppsEffectRunner }
export type { AppsEffectRunner }
