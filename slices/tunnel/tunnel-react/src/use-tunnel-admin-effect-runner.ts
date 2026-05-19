import type { Effect, Scope } from 'effect'
import { useEffectAction } from 'react-kitchen-sink'
import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'

import { useTunnelAdminClientLayer } from './use-tunnel-admin-client-layer.ts'

type TunnelAdminEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, TunnelAdminHttpApiClient | Scope.Scope>
) => Promise<A>

/**
 * Thin wrapper around `useEffectAction` that supplies the tunnel
 * slice's full admin client layer (`TunnelAdminHttpApiClient` +
 * `BearerToken` + `webHttpClientLayer`). Returns a
 * `<A, E>(effect) => Promise<A>` runner for one-off effect executions
 * outside the Suspense flow (button-click handlers that await a write,
 * for example).
 *
 * @example
 * ```ts
 * const run = useTunnelAdminEffectRunner()
 *
 * const setRequestedRunning = async (requestedRunning: boolean): Promise<void> => {
 *   await run(
 *     Effect.flatMap(TunnelAdminHttpApiClient, (c) =>
 *       c.tunnel.PatchTunnel({ payload: { requestedRunning } })
 *     )
 *   )
 * }
 * ```
 */
const useTunnelAdminEffectRunner = (): TunnelAdminEffectRunner =>
  // Runner identity tracks the layer reference; `useTunnelAdminClientLayer`
  // must keep that reference stable across renders for downstream hook
  // deps to be sound.
  useEffectAction(useTunnelAdminClientLayer())

export { useTunnelAdminEffectRunner }
export type { TunnelAdminEffectRunner }
