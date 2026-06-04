import { HttpApiBuilder } from '@effect/platform'
import { AppsAdminApiHandlersFor, AppsApiHandlersFor } from 'apps-core/http-api-implementation'
import { CollectorApiHandlersFor } from 'collector-core/http-api-implementation'
import { Layer } from 'effect'
import {
  FhirPublicApiHandlersFor,
  FhirResourcesApiHandlersFor,
} from 'fhir-r4/http-api-implementation'
import {
  GatekeeperApiHandlersFor,
  RequireAuthMiddlewareLive,
} from 'gatekeeper-core/http-api-implementation'
import { TunnelAdminApiHandlersFor } from 'tunnel-core/http-api-implementation'
import { VendorAppsApiHandlersFor } from 'vendor-apps/http-api-implementation'

import { WildflowerHttpApi } from './http-api-definition.ts'

const WildflowerHttpApiLive = HttpApiBuilder.api(WildflowerHttpApi).pipe(
  Layer.provide(GatekeeperApiHandlersFor<'WildflowerApi'>()),
  Layer.provide(FhirResourcesApiHandlersFor<'WildflowerApi'>()),
  Layer.provide(FhirPublicApiHandlersFor<'WildflowerApi'>()),
  Layer.provide(CollectorApiHandlersFor<'WildflowerApi'>()),
  Layer.provide(AppsApiHandlersFor<'WildflowerApi'>()),
  Layer.provide(AppsAdminApiHandlersFor<'WildflowerApi'>()),
  Layer.provide(TunnelAdminApiHandlersFor<'WildflowerApi'>()),
  Layer.provide(VendorAppsApiHandlersFor<'WildflowerApi'>()),
  Layer.provide(RequireAuthMiddlewareLive)
)

export { WildflowerHttpApiLive }
