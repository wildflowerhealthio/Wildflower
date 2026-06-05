import type { HttpClient } from '@effect/platform'
import type { Layer } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { BearerToken } from 'kitchen-sink/auth-token'
import type { WebApiOrigin } from 'shared-structures-react'

/**
 * Union of services a `GatekeeperHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient`, `BearerToken`, and
 * `WebApiOrigin` unprovided so apps share one of each across every
 * slice's client layer.
 */
type GatekeeperClientRequirements =
  | HttpClient.HttpClient
  | GatekeeperHttpApiClient
  | BearerToken
  | WebApiOrigin

/**
 * Build a `GatekeeperHttpApiClient` layer that reads the bearer token
 * from the {@link BearerToken} service on every request.
 *
 * `GatekeeperHttpApiClient.layer` is produced by `defineSliceHttpClient`
 * with `authType: 'bearer'`, so it already attaches
 * `Authorization: Bearer <token>` via `HttpClient.mapRequestEffect` +
 * `Subscribable.get` per request — a token rotation surfaces on the next
 * call without rebuilding the layer or the client. This builder just
 * re-exposes that layer under a `buildXClientLayer()` name matching the
 * other migrated slices (e.g. `tunnel-react`'s
 * `buildTunnelAdminClientLayer`).
 *
 * Leaves `HttpClient`, `BearerToken`, and `WebApiOrigin` unprovided: the
 * host app supplies one of each (its `webHttpClientLayer`, the
 * `authTokenRef` Subscribable, and the `WebApiOrigin` layer) shared
 * across every slice's client layer via the composed `runtimeLayer`.
 */
const buildGatekeeperClientLayer = (): Layer.Layer<
  GatekeeperHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken | WebApiOrigin
> => GatekeeperHttpApiClient.layer

export { buildGatekeeperClientLayer, type GatekeeperClientRequirements }
