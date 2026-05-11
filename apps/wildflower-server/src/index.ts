import {
  Cookies,
  Headers,
  HttpApi,
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpServerResponse,
} from '@effect/platform'
import { Effect, Layer, pipe } from 'effect'
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

/**
 * CORS allows any origin — this server is intended for broad consumption
 * by SMART-on-FHIR clients, embedded SPAs, and third-party tooling.
 * Tokens travel in `Authorization: Bearer …`, never cookies, so this is
 * not a CSRF surface; {@link stripCookiesMiddleware} enforces the
 * bearer-only contract at runtime.
 */
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

/**
 * Strip outgoing `Set-Cookie` headers and response cookies, logging an
 * error. With `corsMiddleware` allowing any origin and bearer-only auth,
 * any cookie write is unintended and a CSRF risk.
 *
 * @remarks
 * Reconstructs the response via `HttpServerResponse.empty` + `setBody`;
 * the public API has no "remove header" combinator on responses.
 */
const stripCookiesMiddleware = HttpMiddleware.make((app) =>
  Effect.flatMap(app, (response) => {
    const hasSetCookieHeader = Headers.has(response.headers, 'set-cookie')
    const hasCookies = !Cookies.isEmpty(response.cookies)
    if (!hasSetCookieHeader && !hasCookies) return Effect.succeed(response)
    const cleanHeaders = Headers.remove(response.headers, 'set-cookie')
    const cleaned = pipe(
      HttpServerResponse.empty({
        status: response.status,
        statusText: response.statusText,
        headers: cleanHeaders,
        cookies: Cookies.empty,
      }),
      HttpServerResponse.setBody(response.body)
    )
    return Effect.as(
      Effect.logError(
        'Handler attempted to set a cookie; stripping. CORS posture assumes bearer-token auth.'
      ),
      cleaned
    )
  })
)

const middleware = HttpMiddleware.make((app) => stripCookiesMiddleware(corsMiddleware(app)))

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
 * @remarks
 * Platform runner must supply: `HttpServer.HttpServer`,
 * `FileSystem.FileSystem`, `Path.Path`, `WebAssetsDir`, plus the
 * services the API handlers consume (`Origin`, `CryptoRandom`,
 * `LivestoreStore`, `GatekeeperStore`).
 */
const WildflowerServerLive = HttpApiBuilder.serve(middleware).pipe(
  Layer.provide(HttpApiSwagger.layer()),
  Layer.provide(WildflowerHttpApiLive),
  Layer.provide(StaticSpaLive)
)

export { WildflowerHttpApi, WildflowerServerLive }
export { WebAssetsDir } from './static-spa.ts'
