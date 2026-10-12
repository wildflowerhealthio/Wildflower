import { defineSliceHttpClient } from '@wildflowerhealthio/shared-structures-core/http-api-definition'

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
 * `ListApps` + `LaunchApp`. Tokenless: the composing app's `HttpClient`
 * layer carries whatever credential a host that gates the apps surface
 * (the Wildflower server) requires. `LaunchApp` resolves to the launch URL for
 * the caller to navigate to.
 */
class AppsHttpApiClient extends publicHc.ClientTag<AppsHttpApiClient>() {
  static readonly layer = publicHc.makeLayerFactory(AppsHttpApiClient)()
}

/**
 * Effect Service providing the resolved `AppsAdminApi` (owner-only)
 * HttpApi client — app writes (create / update / delete). The composing
 * app wraps `AppsAdminApi` in `RequireAuthMiddleware`; the composing app's
 * `HttpClient` layer carries the bearer that middleware checks.
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
