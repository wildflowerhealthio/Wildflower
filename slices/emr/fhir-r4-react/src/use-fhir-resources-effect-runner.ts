import { Effect, type Scope } from 'effect'
import type { FhirResourcesHttpApiClient } from 'fhir-r4/clients'
import { useCallback } from 'react'

import { useFhirResourcesClientLayer } from './use-fhir-resources-client-layer.ts'

type FhirResourcesEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, FhirResourcesHttpApiClient | Scope.Scope>
) => Promise<A>

/**
 * Returns a runner — a `<A, E>(effect) => Promise<A>` — for one-off
 * effect executions outside the Suspense flow (button-click handlers
 * that await a write, for example). The runner auto-provides the
 * slice's client layer, `BearerToken`, and `webHttpClientLayer`.
 *
 * @example
 * ```ts
 * const run = useFhirResourcesEffectRunner()
 *
 * const create = async (payload: Patient): Promise<void> => {
 *   await run(
 *     Effect.flatMap(FhirResourcesHttpApiClient, (c) =>
 *       c['patient'].CreatePatient({ payload })
 *     )
 *   )
 * }
 * ```
 */
const useFhirResourcesEffectRunner = (): FhirResourcesEffectRunner => {
  const clientLayer = useFhirResourcesClientLayer()

  return useCallback(
    (effect) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(clientLayer),
          // The provided effect may still require a `Scope` (HttpApiClient
          // endpoints scope their request lifecycles). `Effect.scoped` opens
          // a transient scope that closes when the effect settles.
          Effect.scoped
        )
      ),
    [clientLayer]
  )
}

export { useFhirResourcesEffectRunner }
export type { FhirResourcesEffectRunner }
