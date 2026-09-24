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
 * `defineSliceHttpClient`, which sets no `Authorization` header — the
 * provider's `HttpClient` layer decides how requests authenticate. This
 * builder just re-exposes that layer under a
 * `buildXClientLayer()` name matching the other slices (e.g.
 * `gatekeeper-react`'s `buildGatekeeperClientLayer`).
 *
 * The client emits **base-relative** FHIR paths (`/Patient`, not
 * `/fhir-r4/Patient`) — `FhirResourcesApi` no longer bakes in Wildflower's mount
 * prefix, so the client can address any FHIR server. Naming the base is the
 * **provider's** job, not this layer's: the host app re-applies `/fhir-r4` when
 * it wires this layer's `HttpClient` (`apps/wildflower-react`'s
 * `router-context.ts`), and a self-hosted SMART app prepends the `iss` verbatim
 * (`fhir-r4-react/smart`'s `smartHttpClientLayer`).
 *
 * Leaves `HttpClient` unprovided for exactly that reason: the provider supplies
 * an already-addressed one, shared (for the host) across every slice's client
 * layer via the composed `runtimeLayer`.
 */
const buildFhirR4ResourcesClientLayer = (): Layer.Layer<
  FhirR4ResourcesHttpApiClient,
  never,
  HttpClient.HttpClient
> => FhirR4ResourcesHttpApiClient.layer

export { buildFhirR4ResourcesClientLayer, type FhirR4ResourcesClientRequirements }
