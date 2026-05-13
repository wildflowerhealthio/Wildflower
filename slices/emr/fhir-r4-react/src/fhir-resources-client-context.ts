import type { HttpClient } from '@effect/platform'
import type { Layer } from 'effect'
import type { FhirResourcesHttpApiClient } from 'fhir-r4/clients'
import { createContext } from 'react'
import type { BearerToken } from 'react-kitchen-sink'

/**
 * The value shared via context is the slice's client layer —
 * unprovided `HttpClient` and `BearerToken` and all. Apps compose this
 * with other slices' client layers in `useAllClientsLayer()` and
 * provide `HttpClient` + `BearerToken` once.
 *
 * Slice screens shouldn't read the layer directly — use
 * `useFhirResourcesEffect` / `useFhirResourcesStream` /
 * `useFhirResourcesEffectRunner`, which auto-provide everything. The
 * layer is exposed primarily so apps can compose it.
 */
const FhirResourcesClientLayerContext = createContext<Layer.Layer<
  FhirResourcesHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> | null>(null)

export { FhirResourcesClientLayerContext }
