import { HttpApi, HttpApiBuilder, HttpApiSwagger, HttpMiddleware } from '@effect/platform'
import { Layer } from 'effect'
import { FhirPublicApi, FhirResourcesApi } from 'fhir-r4/http-api-definition'
import {
  FhirPublicApiHandlersFor,
  FhirResourcesApiHandlersFor,
  SmartConfigurationLive,
} from 'fhir-r4/http-api-implementation'
import { GatekeeperApi } from 'gatekeeper-core/http-api-definition'
import {
  GatekeeperApiHandlersFor,
  RequireAuthMiddleware,
  RequireAuthMiddlewareLive,
} from 'gatekeeper-core/http-api-implementation'
import { StaticSpaLive } from './static-spa.ts'

// CORS allows any origin: this server is intended for broad consumption by
// SMART-on-FHIR clients, embedded SPAs, and third-party tooling that may run
// from any origin (vendor-app webviews, dev tools, partner integrations).
// Tokens travel in `Authorization: Bearer …`, not cookies, so this is not a
// CSRF surface — the wide allowlist is the desired contract, not a dev
// shortcut.
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

const WildflowerHttpApi = HttpApi.make('WildflowerApi')
  .addHttpApi(GatekeeperApi)
  .addHttpApi(FhirResourcesApi.middleware(RequireAuthMiddleware))
  .addHttpApi(FhirPublicApi)

const WildflowerHttpApiLive = HttpApiBuilder.api(WildflowerHttpApi).pipe(
  Layer.provide(GatekeeperApiHandlersFor<'WildflowerApi'>()),
  Layer.provide(FhirResourcesApiHandlersFor<'WildflowerApi'>()),
  Layer.provide(FhirPublicApiHandlersFor<'WildflowerApi'>()),
  Layer.provide(RequireAuthMiddlewareLive),
  Layer.provide(SmartConfigurationLive)
)

/**
 * Cross-platform server Layer. Composes the HTTP API (Gatekeeper + FHIR
 * resources/public), the SPA static-file fallback, and Swagger docs.
 *
 * Requires the platform-specific runner to provide:
 * - `HttpServer.HttpServer` (e.g. `NodeHttpServer.layer`)
 * - `FileSystem.FileSystem` and `Path.Path` (for the SPA fallback)
 * - `WebAssetsDir` (path to the SPA bundle)
 * - `Origin`, `CryptoRandom`, `LivestoreStore`, `GatekeeperStore`
 *   (consumed by the API handlers).
 */
const WildflowerServerLive = HttpApiBuilder.serve(corsMiddleware).pipe(
  Layer.provide(HttpApiSwagger.layer()),
  Layer.provide(WildflowerHttpApiLive),
  Layer.provide(StaticSpaLive)
)

export { WildflowerHttpApi, WildflowerServerLive }
export { WebAssetsDir } from './static-spa.ts'
export { schema, events, tables } from './schema.ts'
