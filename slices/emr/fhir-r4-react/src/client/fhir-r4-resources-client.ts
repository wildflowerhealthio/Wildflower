import type { HttpClient } from '@effect/platform'
import type { Layer } from 'effect'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'

/**
 * Union of services a `FhirR4ResourcesHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient` unprovided so apps
 * share one across every slice's client layer.
 */
type FhirR4ResourcesClientRequirements = HttpClient.HttpClient | FhirR4ResourcesHttpApiClient

/**
 * Build a tokenless `FhirR4ResourcesHttpApiClient` layer.
 *
 * `FhirR4ResourcesHttpApiClient.layer` is produced by
 * `defineSliceHttpClient`, which sets no `Authorization` header — auth
 * rides the `HttpOnly` `wf_auth` cookie the browser sends with
 * same-origin requests. This builder just re-exposes that layer under a
 * `buildXClientLayer()` name matching the other slices (e.g.
 * `gatekeeper-react`'s `buildGatekeeperClientLayer`).
 *
 * Leaves `HttpClient` unprovided: the host app supplies one
 * (its `webHttpClientLayer`) shared across every slice's client layer
 * via the composed `runtimeLayer`.
 */
const buildFhirR4ResourcesClientLayer = (): Layer.Layer<
  FhirR4ResourcesHttpApiClient,
  never,
  HttpClient.HttpClient
> => FhirR4ResourcesHttpApiClient.layer

export { buildFhirR4ResourcesClientLayer, type FhirR4ResourcesClientRequirements }
