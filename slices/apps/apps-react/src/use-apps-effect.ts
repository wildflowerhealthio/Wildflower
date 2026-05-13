import type { AppsAdminHttpApiClient, AppsHttpApiClient } from 'apps-core/clients'
import { Effect, type Scope } from 'effect'
import { useMemo } from 'react'
import { useEffectTs } from 'react-kitchen-sink'

import { useAppsAdminClientLayer, useAppsClientLayer } from './use-apps-client-layer.ts'

/**
 * React Suspense-friendly runner for an Effect that requires
 * `AppsHttpApiClient` (the *public* apps client — `ListApps` /
 * `LaunchApp`). Auto-provides the slice's public client layer and
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

/**
 * React Suspense-friendly runner for an Effect that requires
 * `AppsAdminHttpApiClient` (the *admin* apps client — custom-app writes
 * + tunnel state). Auto-provides the slice's admin client layer, the
 * `BearerToken` (read from `<AuthTokenProvider>` higher up), and
 * `webHttpClientLayer`.
 *
 * @example
 * ```ts
 * const serverEffect = useMemo(
 *   () => Effect.flatMap(AppsAdminHttpApiClient, (c) => c.server.GetServer()),
 *   [refreshKey]
 * )
 * const serverPromise = useAppsAdminEffect(serverEffect)
 * ```
 */
const useAppsAdminEffect = <A, E>(
  effect: Effect.Effect<A, E, AppsAdminHttpApiClient | Scope.Scope>
): Promise<A> => {
  const clientLayer = useAppsAdminClientLayer()

  const provided = useMemo(() => effect.pipe(Effect.provide(clientLayer)), [effect, clientLayer])

  return useEffectTs(provided)
}

export { useAppsAdminEffect, useAppsEffect }
