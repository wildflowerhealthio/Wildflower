import type { Effect, Scope } from 'effect'
import { useEffectTs } from 'react-kitchen-sink'
import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'

import { useTunnelAdminClientLayer } from './use-tunnel-admin-client-layer.ts'

/**
 * Thin wrapper around `useEffectTs` that supplies the tunnel slice's
 * full admin client layer (`TunnelAdminHttpApiClient` + `BearerToken` +
 * `webHttpClientLayer`). The screen just constructs the Effect; the
 * shared kitchen-sink hook handles fork/exit/scope.
 *
 * @example
 * ```ts
 * const tunnelEffect = useMemo(
 *   () => Effect.flatMap(TunnelAdminHttpApiClient, (c) =>
 *     c.tunnel.GetTunnel()
 *   ),
 *   [refreshKey]
 * )
 * const tunnelPromise = useTunnelAdminEffect(tunnelEffect)
 * ```
 */
const useTunnelAdminEffect = <A, E>(
  effect: Effect.Effect<A, E, TunnelAdminHttpApiClient | Scope.Scope>
): Promise<A> => useEffectTs(effect, useTunnelAdminClientLayer())

export { useTunnelAdminEffect }
