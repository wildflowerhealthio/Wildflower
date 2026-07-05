import type { HttpClient } from '@effect/platform'
import type { Layer } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'

/**
 * Union of services a `GatekeeperHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient` unprovided so apps
 * share one across every slice's client layer.
 */
type GatekeeperClientRequirements = HttpClient.HttpClient | GatekeeperHttpApiClient

/**
 * Build a tokenless `GatekeeperHttpApiClient` layer.
 *
 * `GatekeeperHttpApiClient.layer` is produced by `defineSliceHttpClient`,
 * which sets no `Authorization` header — auth rides the `HttpOnly`
 * `wf_auth` cookie the browser sends with same-origin requests. This
 * builder just re-exposes that layer under a `buildXClientLayer()` name
 * matching the other slices (e.g. `tunnel-react`'s
 * `buildTunnelAdminClientLayer`).
 *
 * Leaves `HttpClient` unprovided: the host app supplies one
 * (its `webHttpClientLayer`) shared across every slice's client layer
 * via the composed `runtimeLayer`.
 */
const buildGatekeeperClientLayer = (): Layer.Layer<
  GatekeeperHttpApiClient,
  never,
  HttpClient.HttpClient
> => GatekeeperHttpApiClient.layer

export { buildGatekeeperClientLayer, type GatekeeperClientRequirements }
