/* oxlint-disable max-dependencies */
import './instrument.ts'
import { createServer } from 'node:http'
import { HttpApi, HttpApiBuilder, HttpApiSwagger, HttpMiddleware } from '@effect/platform'
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import type { ServerState } from 'apps-core/contexts'
import { makeAppsStoreLayer } from 'apps-core/contexts'
import { AppsApi } from 'apps-core/http-api-definition'
import { AppsApiHandlersFor } from 'apps-core/http-api-implementation'
import { AppsWebApi } from 'apps-web'
import { AppsWebApiHandlersFor } from 'apps-web/http-api-implementation'
import { makeCollectorStoreLayer } from 'collector-core/contexts'
import { CollectorApi } from 'collector-core/http-api-definition'
import { CollectorApiHandlersFor } from 'collector-core/http-api-implementation'
import { CollectorWebApi } from 'collector-web'
import { CollectorWebApiHandlersFor } from 'collector-web/http-api-implementation'
import { Effect, Layer } from 'effect'
import { FhirPublicApi, FhirResourcesApi } from 'fhir-r4/http-api-definition'
import {
  FhirPublicApiHandlersFor,
  FhirResourcesApiHandlersFor,
  SmartConfigurationLive,
} from 'fhir-r4/http-api-implementation'
import { makeAuthStoreLayer, OAuthDisplayDefaultInteractive } from 'gatekeeper-core/contexts'
import { AuthApi } from 'gatekeeper-core/http-api-definition'
import {
  AuthApiHandlersFor,
  RequireAuthMiddleware,
  RequireAuthMiddlewareLive,
} from 'gatekeeper-core/http-api-implementation'
import { GatekeeperWebApi } from 'gatekeeper-web'
import { AuthRendererLive } from 'gatekeeper-web/auth-renderer'
import { GatekeeperWebApiHandlersFor } from 'gatekeeper-web/http-api-implementation'
import { Origin } from 'kitchen-sink'
import { makeLivestoreStoreLayer } from 'store-core/contexts'
import { VendorAppsApi } from 'vendor-apps/http-api-definition'
import { VendorAppsApiHandlersFor } from 'vendor-apps/http-api-implementation'
import { createStore } from './LivestoreStore.ts'
import { TelemetryLive } from './telemetry.ts'
import { TunnelControlLive } from './tunnel-control.ts'

const PORT = 3000
const ORIGIN = `http://localhost:${PORT}`

const corsMiddleware = HttpMiddleware.cors({
  allowedOrigins: ['*'],
  allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'origin',
    'accept',
    'x-requested-with',
    'traceparent',
    'tracestate',
    'baggage',
    'sentry-trace',
  ],
})

const WildflowerNodeApi = HttpApi.make('WildflowerNodeApi')
  .addHttpApi(AuthApi)
  .addHttpApi(FhirResourcesApi.middleware(RequireAuthMiddleware))
  .addHttpApi(FhirPublicApi)
  .addHttpApi(AppsApi)
  .addHttpApi(CollectorApi)
  .addHttpApi(VendorAppsApi)
  .addHttpApi(AppsWebApi)
  .addHttpApi(GatekeeperWebApi)
  .addHttpApi(CollectorWebApi)

const state: ServerState = {
  origin: ORIGIN,
  localOrigin: ORIGIN,
  port: PORT,
  tunnelActive: false,
}

const run = Effect.gen(function* () {
  const store = yield* Effect.promise(() => createStore())

  const WildflowerNodeApiLive = HttpApiBuilder.api(WildflowerNodeApi).pipe(
    Layer.provide(AuthApiHandlersFor<'WildflowerNodeApi'>()),
    Layer.provide(FhirPublicApiHandlersFor<'WildflowerNodeApi'>()),
    Layer.provide(FhirResourcesApiHandlersFor<'WildflowerNodeApi'>()),
    Layer.provide(AppsApiHandlersFor<'WildflowerNodeApi'>()),
    Layer.provide(CollectorApiHandlersFor<'WildflowerNodeApi'>()),
    Layer.provide(VendorAppsApiHandlersFor<'WildflowerNodeApi'>()),
    Layer.provide(AppsWebApiHandlersFor<'WildflowerNodeApi'>()),
    Layer.provide(GatekeeperWebApiHandlersFor<'WildflowerNodeApi'>()),
    Layer.provide(CollectorWebApiHandlersFor<'WildflowerNodeApi'>()),
    Layer.provide(AuthRendererLive),
    Layer.provide(RequireAuthMiddlewareLive),
    Layer.provide(OAuthDisplayDefaultInteractive),
    Layer.provide(SmartConfigurationLive),
    Layer.provide(makeLivestoreStoreLayer(store)),
    Layer.provide(makeAuthStoreLayer(store)),
    Layer.provide(makeAppsStoreLayer(store)),
    Layer.provide(makeCollectorStoreLayer(store))
  )

  const ServerLive = HttpApiBuilder.serve(corsMiddleware).pipe(
    Layer.provide(HttpApiSwagger.layer()),
    Layer.provide(WildflowerNodeApiLive),
    Layer.provide(TunnelControlLive(state)),
    Layer.provide(NodeHttpServer.layer(createServer, { port: PORT })),
    Layer.provide(Layer.succeed(Origin, ORIGIN)),
    Layer.provide(TelemetryLive)
  )

  yield* Layer.launch(ServerLive)
})

NodeRuntime.runMain(run)
