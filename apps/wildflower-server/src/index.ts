/* oxlint-disable import/max-dependencies -- cross-platform server composition; one import per slice
   makes the layer graph readable. */
import type { HttpRouter } from '@effect/platform'
import {
  Cookies,
  Headers,
  HttpApi,
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpServerResponse,
} from '@effect/platform'
import type { HttpServer } from '@effect/platform/HttpServer'
import { AppsAdminApi, AppsApi } from 'apps-core/http-api-definition'
import { AppsAdminApiHandlersFor, AppsApiHandlersFor } from 'apps-core/http-api-implementation'
import type { AppsStore } from 'apps-core/livestore'
import { CollectorApi } from 'collector-core/http-api-definition'
import { CollectorApiHandlersFor } from 'collector-core/http-api-implementation'
import type { CollectorStore } from 'collector-core/livestore'
import { Effect, Layer, pipe } from 'effect'
import type { EmrStore } from 'emr-core/livestore'
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
import type { GatekeeperStore } from 'gatekeeper-core/livestore'
import type { CryptoRandom } from 'kitchen-sink/crypto-random'
import type { LocalHttpServerStore } from 'local-http-server-core/livestore'
import type { Origin } from 'navigation-core'
import type { PublicOrigin } from 'tunnel-core/contexts'
import { TunnelAdminApi } from 'tunnel-core/http-api-definition'
import { TunnelAdminApiHandlersFor } from 'tunnel-core/http-api-implementation'
import type { TunnelStore } from 'tunnel-core/livestore'
import { VendorAppsApi } from 'vendor-apps/http-api-definition'
import { VendorAppsApiHandlersFor } from 'vendor-apps/http-api-implementation'
import { StaticSpaLive, type WebAssetsDir } from './static-spa.ts'

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

// Slice surfaces: `AppsApi` (public — `ListApps` + `LaunchApp`,
// reachable by embedded webviews / iframes without a bearer),
// `AppsAdminApi` (owner-only — custom-app writes), and `TunnelAdminApi`
// (owner-only — tunnel state read + toggle). Auth is applied here, in
// the composing app, not in the slices themselves.
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
  Layer.provide(RequireAuthMiddlewareLive),
  Layer.provide(SmartConfigurationLive)
)

/**
 * Cross-platform server Layer. Composes the HTTP API (Gatekeeper +
 * FHIR resources/public + Apps + AppsAdmin + TunnelAdmin + VendorApps),
 * the SPA static-file fallback, and Swagger docs.
 *
 * @remarks
 * Platform runner must supply: `HttpServer.HttpServer`,
 * `FileSystem.FileSystem`, `Path.Path`, `WebAssetsDir`, plus the
 * services the API handlers consume (`Origin`, `PublicOrigin`,
 * `CryptoRandom`, `EmrStore`, `GatekeeperStore`, `CollectorStore`,
 * `AppsStore`, `TunnelStore`, `LocalHttpServerStore`).
 *
 * See `docs/Composition Explanation.md` for the requirements table,
 * the layer graph, and the boot-sequence rationale.
 */
const WildflowerServerLive: Layer.Layer<
  never,
  never,
  | AppsStore
  | CollectorStore
  | CryptoRandom
  | EmrStore
  | GatekeeperStore
  | HttpRouter.HttpRouter.DefaultServices
  | HttpServer
  | LocalHttpServerStore
  | Origin
  | PublicOrigin
  | TunnelStore
  | WebAssetsDir
> = HttpApiBuilder.serve(middleware).pipe(
  Layer.provide(HttpApiSwagger.layer()),
  Layer.provide(WildflowerHttpApiLive),
  Layer.provide(StaticSpaLive)
)

export { WildflowerHttpApi, WildflowerServerLive }
export { WebAssetsDir } from './static-spa.ts'
