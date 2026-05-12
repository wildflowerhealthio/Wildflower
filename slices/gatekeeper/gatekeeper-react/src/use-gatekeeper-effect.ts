import { Effect, type Scope } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { useMemo } from 'react'
import { bearerTokenLayer, useAuthTokenSubscribable, useEffectTs } from 'react-kitchen-sink'
import { webHttpClientLayer } from 'telemetry-react'

import { useGatekeeperClientLayer } from './use-gatekeeper-client-layer.ts'

/**
 * React Suspense-friendly runner for an Effect that requires
 * `GatekeeperHttpApiClient`. Auto-provides the slice's client layer,
 * the `BearerToken` (read from `<AuthTokenProvider>` higher up),
 * and `webHttpClientLayer` — the screen just constructs the Effect
 * without any `Effect.provide(...)` plumbing.
 *
 * @example
 * ```ts
 * const grantsEffect = useMemo(
 *   () => Effect.flatMap(GatekeeperHttpApiClient, (c) =>
 *     c['access-management'].ListGrants()
 *   ),
 *   [refreshKey]
 * )
 * const grantsPromise = useGatekeeperEffect(grantsEffect)
 * ```
 */
const useGatekeeperEffect = <A, E>(
  effect: Effect.Effect<A, E, GatekeeperHttpApiClient | Scope.Scope>
): Promise<A> => {
  const clientLayer = useGatekeeperClientLayer()
  const tokenSubscribable = useAuthTokenSubscribable()

  const provided = useMemo(
    () =>
      effect.pipe(
        Effect.provide(clientLayer),
        Effect.provide(bearerTokenLayer(tokenSubscribable)),
        Effect.provide(webHttpClientLayer)
      ),
    [effect, clientLayer, tokenSubscribable]
  )

  return useEffectTs(provided)
}

export { useGatekeeperEffect }
