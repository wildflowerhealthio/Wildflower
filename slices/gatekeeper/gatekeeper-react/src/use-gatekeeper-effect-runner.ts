import type { Effect, Scope } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { useEffectAction } from 'react-kitchen-sink'

import { useGatekeeperClientLayer } from './use-gatekeeper-client-layer.ts'

type GatekeeperEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, GatekeeperHttpApiClient | Scope.Scope>
) => Promise<A>

/**
 * Thin wrapper around `useEffectAction` that supplies the slice's
 * full client layer (`GatekeeperHttpApiClient` + `BearerToken` +
 * `webHttpClientLayer`). Returns a `<A, E>(effect) => Promise<A>`
 * runner for one-off effect executions outside the Suspense flow
 * (button-click handlers that await a write, for example).
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
const useGatekeeperEffectRunner = (): GatekeeperEffectRunner =>
  useEffectAction(useGatekeeperClientLayer())

export { useGatekeeperEffectRunner }
export type { GatekeeperEffectRunner }
