import type { HttpClient } from '@effect/platform'
import { CollectorHttpApiClient } from 'collector-core/clients'
import type { Layer } from 'effect'
import type { BearerToken } from 'kitchen-sink/auth-token'

/**
 * Union of services a `CollectorHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient` and `BearerToken`
 * unprovided so apps share one of each across every slice's client
 * layer.
 */
type CollectorClientRequirements = HttpClient.HttpClient | CollectorHttpApiClient | BearerToken

/**
 * Build a `CollectorHttpApiClient` layer that reads the bearer token
 * from the {@link BearerToken} service on every request.
 *
 * `CollectorHttpApiClient.layer` is produced by `defineSliceHttpClient`
 * with `authType: 'bearer'`, so it already attaches
 * `Authorization: Bearer <token>` via `HttpClient.mapRequestEffect` +
 * `Subscribable.get` per request — a token rotation surfaces on the next
 * call without rebuilding the layer or the client. This builder just
 * re-exposes that layer under a `buildXClientLayer()` name matching the
 * other migrated slices (e.g. `gatekeeper-react`'s
 * `buildGatekeeperClientLayer`).
 *
 * Leaves `HttpClient` and `BearerToken` unprovided: the host app supplies
 * one of each (its `webHttpClientLayer` + the `authTokenRef` Subscribable)
 * shared across every slice's client layer via the composed
 * `runtimeLayer`.
 */
const buildCollectorClientLayer = (): Layer.Layer<
  CollectorHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> => CollectorHttpApiClient.layer

export { buildCollectorClientLayer, type CollectorClientRequirements }
