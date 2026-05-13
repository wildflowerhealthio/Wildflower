import type { AppsHttpApiClient } from 'apps-core/clients'
import { Effect, type Scope } from 'effect'
import { useMemo } from 'react'
import { useEffectTs } from 'react-kitchen-sink'

import { useAppsClientLayer } from './use-apps-client-layer.ts'

/**
 * React Suspense-friendly runner for an Effect that requires
 * `AppsHttpApiClient`. Auto-provides the slice's client layer, the
 * `BearerToken` (read from `<AuthTokenProvider>` higher up), and
 * `webHttpClientLayer` — the screen just constructs the Effect without
 * any `Effect.provide(...)` plumbing.
 *
 * @example
 * ```ts
 * const appsEffect = useMemo(
 *   () => Effect.flatMap(AppsHttpApiClient, (c) => c.apps.ListApps()),
 *   [refreshKey]
 * )
 * const appsPromise = useAppsEffect(appsEffect)
 * ```
 */
const useAppsEffect = <A, E>(
  effect: Effect.Effect<A, E, AppsHttpApiClient | Scope.Scope>
): Promise<A> => {
  const clientLayer = useAppsClientLayer()

  const provided = useMemo(() => effect.pipe(Effect.provide(clientLayer)), [effect, clientLayer])

  return useEffectTs(provided)
}

export { useAppsEffect }
