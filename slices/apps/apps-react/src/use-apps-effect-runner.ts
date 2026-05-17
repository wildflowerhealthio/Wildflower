import type { AppsAdminHttpApiClient, AppsHttpApiClient } from 'apps-core/clients'
import { Effect, type Scope } from 'effect'
import { useCallback } from 'react'

import { useAppsAdminClientLayer, useAppsClientLayer } from './use-apps-client-layer.ts'

type AppsEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, AppsHttpApiClient | Scope.Scope>
) => Promise<A>

type AppsAdminEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, AppsAdminHttpApiClient | Scope.Scope>
) => Promise<A>

/**
 * Returns a runner — a `<A, E>(effect) => Promise<A>` — for one-off
 * effect executions against the *public* apps client (`ListApps` /
 * `LaunchApp`). The runner auto-provides the slice's public client
 * layer and `webHttpClientLayer`.
 *
 * @example
 * ```ts
 * const run = useAppsEffectRunner()
 *
 * const list = async (): Promise<void> => {
 *   const apps = await run(
 *     Effect.flatMap(AppsHttpApiClient, (c) => c.apps.ListApps())
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

/**
 * Returns a runner — a `<A, E>(effect) => Promise<A>` — for one-off
 * effect executions against the *admin* apps client (custom-app writes).
 * The runner auto-provides the slice's admin client layer, `BearerToken`,
 * and `webHttpClientLayer`.
 *
 * @example
 * ```ts
 * const run = useAppsAdminEffectRunner()
 *
 * const toggle = async (id: string, enabled: boolean): Promise<void> => {
 *   await run(
 *     Effect.flatMap(AppsAdminHttpApiClient, (c) =>
 *       c['apps-admin'].UpdateApp({ path: { id }, payload: { enabled } })
 *     )
 *   )
 * }
 * ```
 */
const useAppsAdminEffectRunner = (): AppsAdminEffectRunner => {
  const clientLayer = useAppsAdminClientLayer()

  return useCallback(
    (effect) => Effect.runPromise(effect.pipe(Effect.provide(clientLayer), Effect.scoped)),
    [clientLayer]
  )
}

export { useAppsAdminEffectRunner, useAppsEffectRunner }
export type { AppsAdminEffectRunner, AppsEffectRunner }
