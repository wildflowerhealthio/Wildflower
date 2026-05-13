import type { Effect, Scope } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { useEffectTs } from 'react-kitchen-sink'

import { useGatekeeperClientLayer } from './use-gatekeeper-client-layer.ts'

/**
 * Thin wrapper around `useEffectTs` that supplies the slice's full
 * client layer (`GatekeeperHttpApiClient` + `BearerToken` +
 * `webHttpClientLayer`). The screen just constructs the Effect; the
 * shared kitchen-sink hook handles fork/exit/scope.
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
): Promise<A> => useEffectTs(effect, useGatekeeperClientLayer())

export { useGatekeeperEffect }
