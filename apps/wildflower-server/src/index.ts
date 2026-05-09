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
 * CORS allows any origin: this server is intended for broad consumption by
 * SMART-on-FHIR clients, embedded SPAs, and third-party tooling that may
 * run from any origin (vendor-app webviews, dev tools, partner
 * integrations). Tokens travel in `Authorization: Bearer …`, never
 * cookies, so this is not a CSRF surface — the wide allowlist is the
 * desired contract, not a dev shortcut.
 *
 * The cookie-stripping policy in `stripCookiesMiddleware` enforces that
 * contract at runtime: any handler that tries to set a cookie has its
 * Set-Cookie stripped and emits a loud error. If a future handler opts
 * into cookie auth, the audit signal fires before the CORS posture
 * silently becomes a vulnerability.
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
 * Strip outgoing `Set-Cookie` headers and any `cookies` set on the
 * `HttpServerResponse`. Because `corsMiddleware` allows any origin and
 * the auth design is bearer-token-only, a handler that sets a cookie
 * would be both unintended and a CSRF risk. Logs an error so the
 * deviation is visible in operator logs. Reconstructs the response via
 * `HttpServerResponse.empty` + `setBody` because the public API lacks a
 * direct "remove header" combinator on responses.
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

const middleware: HttpMiddleware.HttpMiddleware = (app) =>
  stripCookiesMiddleware(corsMiddleware(app))

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
const WildflowerServerLive = HttpApiBuilder.serve(middleware).pipe(
  Layer.provide(HttpApiSwagger.layer()),
  Layer.provide(WildflowerHttpApiLive),
  Layer.provide(StaticSpaLive)
)

export { WildflowerHttpApi, WildflowerServerLive }
export { WebAssetsDir } from './static-spa.ts'
