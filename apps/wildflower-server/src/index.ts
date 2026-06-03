import {
  Cookies,
  Headers,
  HttpApi,
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
} from '@effect/platform'
import { AppsAdminApi, AppsApi } from 'apps-core/http-api-definition'
import { AppsAdminApiHandlersFor, AppsApiHandlersFor } from 'apps-core/http-api-implementation'
import { CollectorApi } from 'collector-core/http-api-definition'
import { CollectorApiHandlersFor } from 'collector-core/http-api-implementation'
import { DateTime, Duration, Effect, Layer, Option, pipe } from 'effect'
import { FhirPublicApi, FhirResourcesApi } from 'fhir-r4/http-api-definition'
import {
  FhirPublicApiHandlersFor,
  FhirResourcesApiHandlersFor,
} from 'fhir-r4/http-api-implementation'
import { GatekeeperApi } from 'gatekeeper-core/http-api-definition'
import {
  GatekeeperApiHandlersFor,
  RequireAuthMiddleware,
  RequireAuthMiddlewareLive,
} from 'gatekeeper-core/http-api-implementation'
import { isLoopbackPeer } from 'navigation-core'
import { TunnelAdminApi } from 'tunnel-core/http-api-definition'
import { TunnelAdminApiHandlersFor } from 'tunnel-core/http-api-implementation'
import { VendorAppsApi } from 'vendor-apps/http-api-definition'
import { VendorAppsApiHandlersFor } from 'vendor-apps/http-api-implementation'
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

/**
 * Access log: one line per request, `method path -> status (Nms)`.
 * Sits at the outermost layer of {@link middleware} so every served
 * route is covered — HttpApi handlers, the SPA fallback, Swagger.
 *
 * @remarks
 * The query string is stripped before logging — bootstrap URLs carry
 * `?token=…` and we don't want bearer material landing in logs. If a
 * request is needed for which the query string matters, capture it at
 * the handler level instead.
 *
 * `req.url` from `@effect/platform` is path-and-query, never absolute,
 * so the simple `indexOf('?')` split is safe — no scheme/host to
 * accidentally swallow.
 */
const accessLogMiddleware = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const start = yield* DateTime.now
    const req = yield* HttpServerRequest.HttpServerRequest
    const pathOnly = (() => {
      const idx = req.url.indexOf('?')
      return idx === -1 ? req.url : req.url.slice(0, idx)
    })()
    const response = yield* app
    const elapsed = DateTime.distanceDuration(start, yield* DateTime.now)
    yield* Effect.logDebug(
      `[http] ${req.method} ${pathOnly} -> ${response.status} (${Duration.toMillis(elapsed)}ms)`
    )
    return response
  })
)

/**
 * Network trust gate: reject any caller whose connection-level remote
 * address isn't loopback (`127.0.0.0/8`, `::1`, `::ffff:127.x`) with a
 * `403`. The server is meant to be reached only over loopback — directly
 * by a local user/webview, or via the local tunnel client (which proxies
 * through `127.0.0.1`); LAN or raw-IP access is denied even when the
 * listener is bound to a non-loopback interface.
 *
 * Pairs with the platform entrypoints' loopback-only bind
 * (`isLoopbackBindHost`) and the per-handler
 * `requestOriginFromHttpRequest` checks, so a forged `Host` from a
 * non-loopback peer can never steer the origin a handler echoes. Sits
 * inside {@link accessLogMiddleware} so rejected peers are still logged.
 */
const loopbackGateMiddleware = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const remoteAddress = Option.getOrUndefined(request.remoteAddress)
    if (isLoopbackPeer(remoteAddress)) {
      return yield* app
    }
    yield* Effect.logWarning(
      `[http] rejected non-loopback peer (remoteAddress=${String(remoteAddress)})`
    )
    return HttpServerResponse.text('Forbidden', {
      status: 403,
      contentType: 'text/plain; charset=utf-8',
    })
  })
)

const middleware = HttpMiddleware.make((app) =>
  pipe(app, corsMiddleware, stripCookiesMiddleware, loopbackGateMiddleware, accessLogMiddleware)
)

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

/**
 * Cross-platform server Layer. Composes the HTTP API (Gatekeeper + FHIR
 * resources/public + Apps + Tunnel + VendorApps), the SPA static-file
 * fallback, and Swagger docs.
 *
 * @remarks
 * Platform runner must supply: `HttpServer.HttpServer`,
 * `FileSystem.FileSystem`, `Path.Path`, `WebAssetsDir`, plus the
 * services the API handlers consume (`Origin`, `CryptoRandom`,
 * `LivestoreStore`, `GatekeeperStore`, `AppsStore`, `TunnelStore`,
 * `LocalHttpServerStore`).
 */
const WildflowerServerLive = HttpApiBuilder.serve(middleware).pipe(
  Layer.provide(
    Layer.merge(Layer.provideMerge(HttpApiSwagger.layer(), WildflowerHttpApiLive), StaticSpaLive)
  )
)

export { WildflowerHttpApi, WildflowerServerLive, loopbackGateMiddleware }
export { WebAssetsDir } from './static-spa.ts'
