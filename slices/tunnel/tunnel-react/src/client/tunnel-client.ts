import type { HttpClient } from '@effect/platform'
import type { Layer } from 'effect'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'

/**
 * Union of services a `TunnelAdminHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient` unprovided so apps
 * share one across every slice's client layer.
 */
type TunnelAdminClientRequirements = HttpClient.HttpClient | TunnelAdminHttpApiClient

/**
 * Build a tokenless `TunnelAdminHttpApiClient` layer.
 *
 * `TunnelAdminHttpApiClient.layer` is produced by `defineSliceHttpClient`,
 * which sets no `Authorization` header — auth rides the `HttpOnly` `wf_auth`
 * cookie the browser sends with same-origin requests. This builder just
 * re-exposes that layer under a `buildXClientLayer()` name matching the other
 * slices. Leaves `HttpClient` unprovided: the host app supplies one (its
 * `webHttpClientLayer`) shared across every slice's client layer via the
 * composed `runtimeLayer`.
 */
const buildTunnelAdminClientLayer = (): Layer.Layer<
  TunnelAdminHttpApiClient,
  never,
  HttpClient.HttpClient
> => TunnelAdminHttpApiClient.layer

export { buildTunnelAdminClientLayer, type TunnelAdminClientRequirements }
