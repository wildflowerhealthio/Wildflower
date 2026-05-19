import { Effect, type Scope } from 'effect'
import { useMemo } from 'react'
import { useEffectTs } from 'react-kitchen-sink'
import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'

import { useTunnelAdminClientLayer } from './use-tunnel-client-layer.ts'

/**
 * React Suspense-friendly runner for an Effect that requires
 * `TunnelAdminHttpApiClient`. Auto-provides the slice's admin client
 * layer, the `BearerToken` (read from `<AuthTokenProvider>` higher up),
 * and `webHttpClientLayer`.
 *
 * @example
 * ```ts
 * const tunnelEffect = useMemo(
 *   () => Effect.flatMap(TunnelAdminHttpApiClient, (c) => c.tunnel.GetTunnel()),
 *   [refreshKey]
 * )
 * const tunnelPromise = useTunnelAdminEffect(tunnelEffect)
 * ```
 */
const useTunnelAdminEffect = <A, E>(
  effect: Effect.Effect<A, E, TunnelAdminHttpApiClient | Scope.Scope>
): Promise<A> => {
  const clientLayer = useTunnelAdminClientLayer()

  const provided = useMemo(() => effect.pipe(Effect.provide(clientLayer)), [effect, clientLayer])

  return useEffectTs(provided)
}

export { useTunnelAdminEffect }
