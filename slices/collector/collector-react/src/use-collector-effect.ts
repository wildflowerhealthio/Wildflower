import type { CollectorHttpApiClient } from 'collector-core/clients'
import type { Effect, Scope } from 'effect'
import { useEffectTs } from 'react-kitchen-sink'

import { useCollectorClientLayer } from './use-collector-client-layer.ts'

/**
 * Thin wrapper around `useEffectTs` that supplies the slice's full
 * client layer (`CollectorHttpApiClient` + `BearerToken` +
 * `webHttpClientLayer`). The screen just constructs the Effect; the
 * shared kitchen-sink hook handles fork/exit/scope.
 *
 * @example
 * ```ts
 * const remotesEffect = useMemo(
 *   () => Effect.flatMap(CollectorHttpApiClient, (c) =>
 *     c['collector-remotes'].ListRemotes()
 *   ),
 *   [refreshKey]
 * )
 * const remotesPromise = useCollectorEffect(remotesEffect)
 * ```
 */
const useCollectorEffect = <A, E>(
  effect: Effect.Effect<A, E, CollectorHttpApiClient | Scope.Scope>
): Promise<A> => useEffectTs(effect, useCollectorClientLayer())

export { useCollectorEffect }
