import type { HttpClient } from '@effect/platform'
import { AppsRouterContext } from '@wildflowerhealthio/apps-react'
import { AuthorizationRouterContext } from '@wildflowerhealthio/authorization-react'
import { DatabasesRouterContext } from '@wildflowerhealthio/databases-react'
import { FhirR4ResourcesRouterContext } from '@wildflowerhealthio/fhir-r4-react'
import { RequestLogRouterContext } from '@wildflowerhealthio/request-log-react'
import { Effect, Layer } from 'effect'

import type { RunAuthed, RuntimeLayer } from './router-context.ts'

/**
 * Builds the page-lifetime runtime layer + authed runner. The runtime
 * attaches no credential itself: the transport decides how a request
 * authenticates — `attachBearer` stamps the session's bearer on.
 *
 * The `beforeLoad` auth gate (not the loaders) guarantees the auth
 * signal is ready before any authed loader runs, so there's no
 * `isTokenReady` reader here — loaders are plain `ensureQueryData`.
 * Nothing is re-sent: every request carries the bearer the sign-in already
 * redeemed, so a 401 means the session is over.
 *
 * @param apiTransport - The API server's transport, which every slice's
 *   client (FHIR's included: the server serves it at its root) sends through.
 *   `app-query-runtime.ts`'s `apiTransport` builds it over the page's
 *   session, so it decides the server and how a request authenticates.
 * @param effectTelemetryLayer - The page's Effect telemetry layer, merged
 *   into the runtime so every authed request runs under the page's tracer
 *   (see `RenderAppOptions.effectTelemetryLayer`)
 */
const buildRunAuthed = (
  apiTransport: Layer.Layer<HttpClient.HttpClient>,
  effectTelemetryLayer: Layer.Layer<never>
): {
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
} => {
  const baseRuntimeLayer = Layer.mergeAll(apiTransport, effectTelemetryLayer)
  const runtimeLayer: RuntimeLayer = Layer.provideMerge(
    Layer.mergeAll(
      AppsRouterContext.sliceRuntimeLayer,
      AuthorizationRouterContext.sliceRuntimeLayer,
      FhirR4ResourcesRouterContext.sliceRuntimeLayer,
      DatabasesRouterContext.sliceRuntimeLayer,
      RequestLogRouterContext.sliceRuntimeLayer
    ),
    baseRuntimeLayer
  )
  return {
    runAuthed: (effect, options) =>
      Effect.runPromise(Effect.provide(effect, runtimeLayer), options),
    runtimeLayer,
  }
}

export { buildRunAuthed }
