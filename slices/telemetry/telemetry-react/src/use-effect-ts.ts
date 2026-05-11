import type { HttpClient } from '@effect/platform'
import { Effect, type Scope } from 'effect'
import { useMemo } from 'react'
import { useEffectTs as useEffectTsCore } from 'react-kitchen-sink'

import { webHttpClientLayer } from './web-http-client-layer.ts'

/**
 * React Suspense-friendly Effect runner that auto-provides the
 * web-side {@link webHttpClientLayer}. Mirrors `react-kitchen-sink`'s
 * `useEffectTs` shape, minus the `runtime` argument: callers feed an
 * effect whose remaining requirements are `HttpClient.HttpClient` (and
 * optionally `Scope.Scope`) and this hook supplies the HTTP client so
 * the underlying runner sees a context-free effect.
 *
 * Combine with each slice's client layer:
 *
 * ```ts
 * const layer = useGatekeeperClientLayer()
 * const effect = useMemo(
 *   () => Effect.flatMap(GatekeeperHttpApiClient, (c) =>
 *     c['access-management'].ListGrants()
 *   ).pipe(Effect.provide(layer)),
 *   [layer]
 * )
 * const grantsPromise = useEffectTs(effect)
 * ```
 *
 * For ad-hoc effects without slice plumbing (e.g. logging),
 * `R = never` works fine — `Effect.provide(webHttpClientLayer)` is a
 * no-op for effects whose context already excludes `HttpClient`.
 */
const useEffectTs = <A, E, R extends HttpClient.HttpClient | Scope.Scope = HttpClient.HttpClient>(
  effect: Effect.Effect<A, E, R>
): Promise<A> => {
  const provided = useMemo(() => Effect.provide(effect, webHttpClientLayer), [effect])
  return useEffectTsCore(provided)
}

export { useEffectTs }
