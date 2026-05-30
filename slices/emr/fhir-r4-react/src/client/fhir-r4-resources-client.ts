import type { HttpClient } from '@effect/platform'
import type { Layer } from 'effect'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { BearerToken } from 'kitchen-sink/auth-token'

/**
 * Union of services a `FhirR4ResourcesHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient` and `BearerToken`
 * unprovided so apps share one of each across every slice's client
 * layer.
 */
type FhirR4ResourcesClientRequirements =
  | HttpClient.HttpClient
  | FhirR4ResourcesHttpApiClient
  | BearerToken

/**
 * Build a `FhirR4ResourcesHttpApiClient` layer that reads the bearer
 * token from the {@link BearerToken} service on every request.
 *
 * `FhirR4ResourcesHttpApiClient.layer` is produced by
 * `defineSliceHttpClient` with `authType: 'bearer'`, so it already
 * attaches `Authorization: Bearer <token>` via
 * `HttpClient.mapRequestEffect` + `Subscribable.get` per request — a
 * token rotation surfaces on the next call without rebuilding the layer
 * or the client. This builder just re-exposes that layer under a
 * `buildXClientLayer()` name matching the other migrated slices (e.g.
 * `gatekeeper-react`'s `buildGatekeeperClientLayer`).
 *
 * Leaves `HttpClient` and `BearerToken` unprovided: the host app
 * supplies one of each (its `webHttpClientLayer` + the `authTokenRef`
 * Subscribable) shared across every slice's client layer via the
 * composed `runtimeLayer`.
 */
const buildFhirR4ResourcesClientLayer = (): Layer.Layer<
  FhirR4ResourcesHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> => FhirR4ResourcesHttpApiClient.layer

export { buildFhirR4ResourcesClientLayer, type FhirR4ResourcesClientRequirements }
