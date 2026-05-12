import { Effect, type Scope } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { useCallback } from 'react'
import { bearerTokenLayer, useAuthTokenSubscribable } from 'react-kitchen-sink'
import { webHttpClientLayer } from 'telemetry-react'

import { useGatekeeperClientLayer } from './use-gatekeeper-client-layer.ts'

type GatekeeperEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, GatekeeperHttpApiClient | Scope.Scope>
) => Promise<A>

/**
 * Returns a runner — a `<A, E>(effect) => Promise<A>` — for one-off
 * effect executions outside the Suspense flow (button-click handlers
 * that await a write, for example). The runner auto-provides the
 * slice's client layer, `BearerToken`, and `webHttpClientLayer`.
 *
 * @example
 * ```ts
 * const run = useGatekeeperEffectRunner()
 *
 * const revoke = async (id: string): Promise<void> => {
 *   await run(
 *     Effect.flatMap(GatekeeperHttpApiClient, (c) =>
 *       c['access-management'].RevokeGrant({ path: { id } })
 *     )
 *   )
 * }
 * ```
 */
const useGatekeeperEffectRunner = (): GatekeeperEffectRunner => {
  const clientLayer = useGatekeeperClientLayer()
  const tokenSubscribable = useAuthTokenSubscribable()

  return useCallback(
    (effect) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(clientLayer),
          Effect.provide(bearerTokenLayer(tokenSubscribable)),
          Effect.provide(webHttpClientLayer),
          // The provided effect may still require a `Scope` (HttpApiClient
          // endpoints scope their request lifecycles). `Effect.scoped` opens
          // a transient scope that closes when the effect settles.
          Effect.scoped
        )
      ),
    [clientLayer, tokenSubscribable]
  )
}

export { useGatekeeperEffectRunner }
export type { GatekeeperEffectRunner }
