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
 * `useFhirR4ResourcesEffectAction` / `useFhirR4ResourcesStream`
 * surface that screens and the app shell consume.
 */
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { defineSliceReact } from 'shared-structures-react'

const fhirR4ResourcesSlice = defineSliceReact({
  ClientTag: FhirR4ResourcesHttpApiClient,
  layer: FhirR4ResourcesHttpApiClient.layer,
  authType: FhirR4ResourcesHttpApiClient.authType,
  contextName: 'FhirR4Resources',
})

const {
  ClientLayerContext: FhirR4ResourcesClientLayerContext,
  ClientProvider: FhirR4ResourcesClientProvider,
  useClientLayer: useFhirR4ResourcesClientLayer,
  useEffectTs: useFhirR4ResourcesEffect,
  useEffectAction: useFhirR4ResourcesEffectAction,
  useStream: useFhirR4ResourcesStream,
} = fhirR4ResourcesSlice

/**
 * Type returned by {@link useFhirR4ResourcesEffectAction}: an
 * imperative Effect runner pre-bound to the slice's client layer.
 */
type FhirR4ResourcesEffectAction = ReturnType<typeof fhirR4ResourcesSlice.useEffectAction>

export {
  FhirR4ResourcesClientLayerContext,
  FhirR4ResourcesClientProvider,
  useFhirR4ResourcesClientLayer,
  useFhirR4ResourcesEffect,
  useFhirR4ResourcesEffectAction,
  useFhirR4ResourcesStream,
}
export type { FhirR4ResourcesEffectAction }
