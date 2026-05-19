import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'

import { AppsAdminApi, AppsApi } from '../http-api-definition/index.ts'

const publicHc = defineSliceHttpClient({
  name: 'AppsHttpApiClient',
  api: AppsApi,
  auth: 'none',
})

const adminHc = defineSliceHttpClient({
  name: 'AppsAdminHttpApiClient',
  api: AppsAdminApi,
  auth: 'bearer',
})

/**
 * Effect Service providing the resolved `AppsApi` (public) HttpApi
 * client — `ListApps` + `LaunchApp`. No bearer token required;
 * consumers should *not* attach `Authorization` headers.
 */
class AppsHttpApiClient extends publicHc.ClientTag<AppsHttpApiClient>() {
  static readonly layer = publicHc.makeLayerFactory(AppsHttpApiClient)()
  static readonly auth = publicHc.auth
}

/**
 * Effect Service providing the resolved `AppsAdminApi` (owner-only)
 * HttpApi client — custom-app writes. The composing app wraps
 * `AppsAdminApi` in `RequireAuthMiddleware`, so the corresponding
 * client layer must attach a bearer.
 */
class AppsAdminHttpApiClient extends adminHc.ClientTag<AppsAdminHttpApiClient>() {
  static readonly layer = adminHc.makeLayerFactory(AppsAdminHttpApiClient)()
  static readonly auth = adminHc.auth
}

type AppsHttpApiClientShape = typeof AppsHttpApiClient.Service
type AppsAdminHttpApiClientShape = typeof AppsAdminHttpApiClient.Service

export {
  AppsAdminHttpApiClient,
  AppsHttpApiClient,
  type AppsAdminHttpApiClientShape,
  type AppsHttpApiClientShape,
}
