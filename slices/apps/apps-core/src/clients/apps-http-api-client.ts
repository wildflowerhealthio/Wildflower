import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'

import { AppsAdminApi, AppsApi } from '../http-api-definition/index.ts'

const publicHc = defineSliceHttpClient({
  name: 'AppsHttpApiClient',
  api: AppsApi,
  authType: 'bearer',
})

const adminHc = defineSliceHttpClient({
  name: 'AppsAdminHttpApiClient',
  api: AppsAdminApi,
  authType: 'bearer',
})

/**
 * Effect Service providing the resolved `AppsApi` HttpApi client —
 * `ListApps` + `LaunchApp`. Attaches a bearer: hosts that gate the
 * apps surface (e.g. the Tauri host's Rust server) reject anonymous
 * reads, and hosts that don't yet (wildflower-server) ignore the
 * header. Note `LaunchApp` is normally driven via `window.location`
 * navigation (which carries no bearer), not through this client.
 */
class AppsHttpApiClient extends publicHc.ClientTag<AppsHttpApiClient>() {
  static readonly layer = publicHc.makeLayerFactory(AppsHttpApiClient)()
  static readonly authType = publicHc.authType
}

/**
 * Effect Service providing the resolved `AppsAdminApi` (owner-only)
 * HttpApi client — custom-app writes. The composing app wraps
 * `AppsAdminApi` in `RequireAuthMiddleware`, so the corresponding
 * client layer must attach a bearer.
 */
class AppsAdminHttpApiClient extends adminHc.ClientTag<AppsAdminHttpApiClient>() {
  static readonly layer = adminHc.makeLayerFactory(AppsAdminHttpApiClient)()
  static readonly authType = adminHc.authType
}

type AppsHttpApiClientShape = typeof AppsHttpApiClient.Service
type AppsAdminHttpApiClientShape = typeof AppsAdminHttpApiClient.Service

export {
  AppsAdminHttpApiClient,
  AppsHttpApiClient,
  type AppsAdminHttpApiClientShape,
  type AppsHttpApiClientShape,
}
