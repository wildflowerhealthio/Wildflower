import type { CollectorHttpApiClient } from 'collector-core/clients'
import { Effect, type Scope } from 'effect'
import { useMemo } from 'react'
import { useEffectTs } from 'react-kitchen-sink'

import { useCollectorClientLayer } from './use-collector-client-layer.ts'

/**
 * React Suspense-friendly runner for an Effect that requires
 * `CollectorHttpApiClient`. Auto-provides the slice's client layer,
 * the `BearerToken` (read from `<AuthTokenProvider>` higher up),
 * and `webHttpClientLayer` — the screen just constructs the Effect
 * without any `Effect.provide(...)` plumbing.
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
): Promise<A> => {
  const clientLayer = useCollectorClientLayer()

  const provided = useMemo(() => effect.pipe(Effect.provide(clientLayer)), [effect, clientLayer])

  return useEffectTs(provided)
}

export { useCollectorEffect }
