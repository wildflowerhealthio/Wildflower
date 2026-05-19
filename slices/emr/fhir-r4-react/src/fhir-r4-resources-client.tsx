// `defineSliceReact` returns a `ClientProvider` component alongside
// the hooks; the lint rule fires on the destructured re-export
// because it can't tell the component is meant to be consumed via
// this single barrel. Disable at the file level.
/* oxlint-disable react/only-export-components */
/**
 * Slice-react boilerplate, generated via `defineSliceReact` from
 * `shared-structures-react`. Exposes the
 * `FhirR4ResourcesClientLayerContext` / `FhirR4ResourcesClientProvider`
 * / `useFhirR4ResourcesClientLayer` / `useFhirR4ResourcesEffect` /
 * `useFhirR4ResourcesEffectRunner` / `useFhirR4ResourcesStream`
 * surface that screens and the app shell consume.
 */
import type { Effect, Scope } from 'effect'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { defineSliceReact } from 'shared-structures-react'

const {
  ClientLayerContext: FhirR4ResourcesClientLayerContext,
  ClientProvider: FhirR4ResourcesClientProvider,
  useClientLayer: useFhirR4ResourcesClientLayer,
  useEffect: useFhirR4ResourcesEffect,
  useEffectRunner: useFhirR4ResourcesEffectRunner,
  useStream: useFhirR4ResourcesStream,
} = defineSliceReact({
  ClientTag: FhirR4ResourcesHttpApiClient,
  layer: FhirR4ResourcesHttpApiClient.layer,
  auth: FhirR4ResourcesHttpApiClient.auth,
  contextName: 'FhirR4Resources',
})

/**
 * Type returned by {@link useFhirR4ResourcesEffectRunner}: an
 * imperative Effect runner pre-bound to the slice's client layer.
 */
type FhirR4ResourcesEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, FhirR4ResourcesHttpApiClient | Scope.Scope>
) => Promise<A>

export {
  FhirR4ResourcesClientLayerContext,
  FhirR4ResourcesClientProvider,
  useFhirR4ResourcesClientLayer,
  useFhirR4ResourcesEffect,
  useFhirR4ResourcesEffectRunner,
  useFhirR4ResourcesStream,
}
export type { FhirR4ResourcesEffectRunner }
