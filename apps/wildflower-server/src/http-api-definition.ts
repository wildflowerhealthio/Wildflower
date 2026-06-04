import { HttpApi } from '@effect/platform'
import { AppsAdminApi, AppsApi } from 'apps-core/http-api-definition'
import { CollectorApi } from 'collector-core/http-api-definition'
import { FhirPublicApi, FhirResourcesApi } from 'fhir-r4/http-api-definition'
import { GatekeeperApi } from 'gatekeeper-core/http-api-definition'
import { RequireAuthMiddleware } from 'gatekeeper-core/http-api-implementation'
import { TunnelAdminApi } from 'tunnel-core/http-api-definition'
import { VendorAppsApi } from 'vendor-apps/http-api-definition'

// The apps slice exposes two HttpApis: `AppsApi` (public — `ListApps`
// + `LaunchApp`, reachable by embedded webviews / iframes without a
// bearer) and `AppsAdminApi` (owner-only — custom-app writes).
// `TunnelAdminApi` carries the read/write tunnel-state endpoints
// (formerly the apps-admin `Server` group, now its own slice). Auth
// is applied here, in the composing app, not in the slice itself.
const WildflowerHttpApi = HttpApi.make('WildflowerApi')
  .addHttpApi(GatekeeperApi)
  .addHttpApi(FhirResourcesApi.middleware(RequireAuthMiddleware))
  .addHttpApi(FhirPublicApi)
  .addHttpApi(CollectorApi.middleware(RequireAuthMiddleware))
  .addHttpApi(AppsApi)
  .addHttpApi(AppsAdminApi.middleware(RequireAuthMiddleware))
  .addHttpApi(TunnelAdminApi.middleware(RequireAuthMiddleware))
  .addHttpApi(VendorAppsApi)

export { WildflowerHttpApi }
