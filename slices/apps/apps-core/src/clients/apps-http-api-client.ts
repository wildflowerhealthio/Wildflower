import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'

import { AppsAdminApi, AppsApi } from '../http-api-definition/index.ts'

const publicHc = defineSliceHttpClient({
  name: 'AppsHttpApiClient',
  api: AppsApi,
})

const adminHc = defineSliceHttpClient({
  name: 'AppsAdminHttpApiClient',
  api: AppsAdminApi,
})

/**
 * Effect Service providing the resolved `AppsApi` HttpApi client —
 * `ListApps` + `LaunchApp`. Tokenless: hosts that gate the apps surface
 * (e.g. the Tauri host's Rust server) authenticate via the request's
 * cookie. `LaunchApp` resolves to the launch URL for a forwarded caller
 * to navigate to, or to nothing when the host opened the app itself.
 */
class AppsHttpApiClient extends publicHc.ClientTag<AppsHttpApiClient>() {
  static readonly layer = publicHc.makeLayerFactory(AppsHttpApiClient)()
}

/**
 * Effect Service providing the resolved `AppsAdminApi` (owner-only)
 * HttpApi client — app writes (create / update / delete). The composing
 * app wraps `AppsAdminApi` in `RequireAuthMiddleware`; auth rides the
 * same-origin cookie the browser sends with each request.
 */
class AppsAdminHttpApiClient extends adminHc.ClientTag<AppsAdminHttpApiClient>() {
  static readonly layer = adminHc.makeLayerFactory(AppsAdminHttpApiClient)()
}

type AppsHttpApiClientShape = typeof AppsHttpApiClient.Service
type AppsAdminHttpApiClientShape = typeof AppsAdminHttpApiClient.Service

export {
  AppsAdminHttpApiClient,
  AppsHttpApiClient,
  type AppsAdminHttpApiClientShape,
  type AppsHttpApiClientShape,
}
