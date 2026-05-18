import { Effect, type Scope } from 'effect'
import { useCallback } from 'react'
import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'

import { useTunnelAdminClientLayer } from './use-tunnel-client-layer.ts'

type TunnelAdminEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, TunnelAdminHttpApiClient | Scope.Scope>
) => Promise<A>

/**
 * Returns a runner — a `<A, E>(effect) => Promise<A>` — for one-off
 * effect executions against the tunnel-admin client. The runner
 * auto-provides the slice's admin client layer, `BearerToken`, and
 * `webHttpClientLayer`.
 */
const useTunnelAdminEffectRunner = (): TunnelAdminEffectRunner => {
  const clientLayer = useTunnelAdminClientLayer()

  return useCallback(
    (effect) => Effect.runPromise(effect.pipe(Effect.provide(clientLayer), Effect.scoped)),
    [clientLayer]
  )
}

export { useTunnelAdminEffectRunner }
export type { TunnelAdminEffectRunner }
