import { Effect, type Scope } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { useMemo } from 'react'
import { useEffectTs } from 'react-kitchen-sink'

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

  const provided = useMemo(() => effect.pipe(Effect.provide(clientLayer)), [effect, clientLayer])

  return useEffectTs(provided)
}

export { useGatekeeperEffect }
