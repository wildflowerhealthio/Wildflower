import type { HttpClient } from '@effect/platform'
import { CollectorHttpApiClient } from 'collector-core/clients'
import type { Layer } from 'effect'
import type { BearerToken } from 'kitchen-sink/auth-token'
import type { WebApiOrigin } from 'shared-structures-react'

/**
 * Union of services a `CollectorHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient`, `BearerToken`, and
 * `WebApiOrigin` unprovided so apps share one of each across every
 * slice's client layer.
 */
type CollectorClientRequirements =
  | HttpClient.HttpClient
  | CollectorHttpApiClient
  | BearerToken
  | WebApiOrigin

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
 * Leaves `HttpClient`, `BearerToken`, and `WebApiOrigin` unprovided: the
 * host app supplies one of each (its `webHttpClientLayer`, the
 * `authTokenRef` Subscribable, and the `WebApiOrigin` layer) shared
 * across every slice's client layer via the composed `runtimeLayer`.
 */
const buildCollectorClientLayer = (): Layer.Layer<
  CollectorHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken | WebApiOrigin
> => CollectorHttpApiClient.layer

export { buildCollectorClientLayer, type CollectorClientRequirements }
