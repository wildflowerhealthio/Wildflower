import type { HttpClient } from '@effect/platform'
import { HttpApiClient } from '@effect/platform'
import { Layer } from 'effect'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { TunnelAdminApi } from 'tunnel-core/http-api-definition'

/**
 * Union of services a `TunnelAdminHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient` unprovided so apps
 * share one across every slice's client layer.
 */
type TunnelAdminClientRequirements = HttpClient.HttpClient | TunnelAdminHttpApiClient

/**
 * Build a tokenless `TunnelAdminHttpApiClient` layer.
 *
 * `TunnelAdminApi` is composed under `RequireAuthMiddleware` by the
 * host server (e.g. `wildflower-server`); auth rides the `HttpOnly`
 * `wf_auth` cookie the browser sends with same-origin requests, so the
 * client sets no `Authorization` header.
 */
const buildTunnelAdminClientLayer = (): Layer.Layer<
  TunnelAdminHttpApiClient,
  never,
  HttpClient.HttpClient
> =>
  Layer.effect(
    TunnelAdminHttpApiClient,
    // No `baseUrl`: a `'/'` base is prepended *after* app-level request
    // transforms and corrupts URLs when an origin prepend (the Tauri
    // entry's `apiBaseUrl`) already made them absolute.
    HttpApiClient.make(TunnelAdminApi)
  )

export { buildTunnelAdminClientLayer, type TunnelAdminClientRequirements }
