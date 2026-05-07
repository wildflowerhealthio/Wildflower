import './instrument.ts'
import { createServer } from 'node:http'
import { HttpApi, HttpApiBuilder, HttpApiSwagger, HttpMiddleware } from '@effect/platform'
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { makeLivestoreStoreLayer } from 'emr-core/contexts'
import { FhirPublicApi, FhirResourcesApi } from 'fhir-r4/http-api-definition'
import {
  FhirPublicApiHandlersFor,
  FhirResourcesApiHandlersFor,
  SmartConfigurationLive,
} from 'fhir-r4/http-api-implementation'
import { makeGatekeeperStoreLayer } from 'gatekeeper-core/contexts'
import { GatekeeperApi } from 'gatekeeper-core/http-api-definition'
import {
  GatekeeperApiHandlersFor,
  RequireAuthMiddleware,
  RequireAuthMiddlewareLive,
} from 'gatekeeper-core/http-api-implementation'
import { GatekeeperPagesHandlersFor } from 'gatekeeper-web'
import { Origin } from 'kitchen-sink'
import { CryptoRandomLayerLive } from 'kitchen-sink/crypto-random'
import { createStore } from './LivestoreStore.ts'
import { TelemetryLive } from './telemetry.ts'

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
  .addHttpApi(GatekeeperApi)
  .addHttpApi(FhirResourcesApi.middleware(RequireAuthMiddleware))
  .addHttpApi(FhirPublicApi)

const CryptoRandomLive = CryptoRandomLayerLive<
  Uint8Array & ReturnType<typeof globalThis.crypto.getRandomValues>
>(globalThis.crypto, new Uint8Array(1))

const run = Effect.gen(function* () {
  const store = yield* Effect.promise(() => createStore())

  const WildflowerNodeApiLive = HttpApiBuilder.api(WildflowerNodeApi).pipe(
    Layer.provide(GatekeeperApiHandlersFor<'WildflowerNodeApi'>()),
    Layer.provide(FhirResourcesApiHandlersFor<'WildflowerNodeApi'>()),
    Layer.provide(FhirPublicApiHandlersFor<'WildflowerNodeApi'>()),
    Layer.provide(GatekeeperPagesHandlersFor<'WildflowerNodeApi'>()),
    Layer.provide(RequireAuthMiddlewareLive),
    Layer.provide(SmartConfigurationLive),
    Layer.provide(makeLivestoreStoreLayer(store)),
    Layer.provide(makeGatekeeperStoreLayer(store)),
    Layer.provide(CryptoRandomLive)
  )

  const ServerLive = HttpApiBuilder.serve(corsMiddleware).pipe(
    Layer.provide(HttpApiSwagger.layer()),
    Layer.provide(WildflowerNodeApiLive),
    Layer.provide(NodeHttpServer.layer(createServer, { port: PORT })),
    Layer.provide(Layer.succeed(Origin, ORIGIN)),
    Layer.provide(TelemetryLive)
  )

  yield* Effect.logInfo(`Server is running at ${ORIGIN}...`)
  yield* Layer.launch(ServerLive)
})

NodeRuntime.runMain(run)
