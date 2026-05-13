import type { CollectorHttpApiClient } from 'collector-core/clients'
import type { Effect, Scope } from 'effect'
import { useEffectAction } from 'react-kitchen-sink'

import { useCollectorClientLayer } from './use-collector-client-layer.ts'

type CollectorEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, CollectorHttpApiClient | Scope.Scope>
) => Promise<A>

/**
 * Thin wrapper around `useEffectAction` that supplies the slice's
 * full client layer (`CollectorHttpApiClient` + `BearerToken` +
 * `webHttpClientLayer`). Returns a `<A, E>(effect) => Promise<A>`
 * runner for one-off effect executions outside the Suspense flow
 * (button-click handlers that await a write, for example).
 *
 * @example
 * ```ts
 * const run = useCollectorEffectRunner()
 *
 * const deleteRemote = async (id: string): Promise<void> => {
 *   await run(
 *     Effect.flatMap(CollectorHttpApiClient, (c) =>
 *       c['collector-remotes'].DeleteRemote({ path: { id } })
 *     )
 *   )
 * }
 * ```
 */
const useCollectorEffectRunner = (): CollectorEffectRunner =>
  // Runner identity tracks the layer reference; `useCollectorClientLayer`
  // must keep that reference stable across renders for downstream hook
  // deps to be sound.
  useEffectAction(useCollectorClientLayer())

export { useCollectorEffectRunner }
export type { CollectorEffectRunner }
