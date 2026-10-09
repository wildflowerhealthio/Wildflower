import type { HttpClient } from '@effect/platform'
import { AppsRouterContext } from 'apps-react'
import { CollectorRouterContext } from 'collector-react'
import { DatabasesRouterContext } from 'databases-react'
import { Effect, Layer, pipe } from 'effect'
import { FhirR4ResourcesRouterContext } from 'fhir-r4-react'
import { FhirResourcesApiPrefix } from 'fhir-r4/http-api-definition'
import { GatekeeperRouterContext } from 'gatekeeper-react'
import { RequestLogRouterContext } from 'request-log-react'

import { unauthorizedRetrySchedule } from './retry-policy.ts'
import type { RunAuthed, RuntimeLayer } from './router-context.ts'

/**
 * The API server's transport for the requests mounted at `mountPath` on it —
 * `''` for the server root (every slice but FHIR), `/fhir-r4` for the FHIR
 * slice. The entry builds it (`app-query-runtime.ts`'s `apiTransportAt`), so
 * it decides the origin and how a request authenticates.
 */
type ApiTransport = (mountPath: string) => Layer.Layer<HttpClient.HttpClient>

/**
 * Builds the page-lifetime runtime layer + authed runner. The runtime
 * attaches no credential itself: the entry's transport decides how a
 * request authenticates — the hosted web entry's `readBearer` is stamped on by
 * `attachBearer`, and on Tauri the host stamps its owner bearer onto direct-loopback requests
 * by connection provenance.
 *
 * The `beforeLoad` auth gate (not the loaders) guarantees the auth
 * signal is ready before any authed loader runs, so there's no
 * `isTokenReady` reader here — loaders are plain `ensureQueryData`.
 *
 * @param effectTelemetryLayer - The entry's Effect telemetry layer, merged
 *   into the runtime so every authed request runs under the page's tracer
 *   (see `RenderAppOptions.effectTelemetryLayer`)
 */
const buildRunAuthed = (
  transportAt: ApiTransport,
  effectTelemetryLayer: Layer.Layer<never>
): {
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
} => {
  const baseRuntimeLayer = Layer.mergeAll(transportAt(''), effectTelemetryLayer)
  const runtimeLayer: RuntimeLayer = Layer.provideMerge(
    Layer.mergeAll(
      AppsRouterContext.sliceRuntimeLayer,
      GatekeeperRouterContext.sliceRuntimeLayer,
      CollectorRouterContext.sliceRuntimeLayer,
      // The FHIR slice's typed client emits base-relative paths (`/Patient`) —
      // `FhirResourcesApi` does not bake in the mount prefix — so it gets the
      // entry's transport mounted at `/fhir-r4`, while every other slice keeps
      // the root-mounted `baseRuntimeLayer` transport. The entry joins the mount
      // path onto the API origin in one prefix (`{origin}/fhir-r4`); stacking a
      // second prefix wrapper over an origin-prefixing layer does not work,
      // because `HttpClient.mapRequest` runs the wrapped client's rewrite first,
      // so the outer `/fhir-r4` wrapper would see an absolute URL and skip it.
      FhirR4ResourcesRouterContext.sliceRuntimeLayer.pipe(
        Layer.provide(transportAt(FhirResourcesApiPrefix))
      ),
      DatabasesRouterContext.sliceRuntimeLayer,
      RequestLogRouterContext.sliceRuntimeLayer
    ),
    baseRuntimeLayer
  )
  // The boot-race retry only covers the *boot window*. On Tauri the host binds
  // its loopback listener before it mints the host owner token, so a request
  // the page sends in that gap reaches the server with no owner bearer stamped
  // on it and comes back 401. Once any authed request has succeeded, the
  // credential is demonstrably in place, so `booted` latches on and later 401s
  // skip the retry entirely: a genuine expiry then propagates immediately (no
  // 4×150ms re-send per query) and the QueryCache `onError` redirect fires
  // without delay.
  let booted = false
  return {
    // The retry sits *inside* the runner (before `provide`, so each re-send
    // re-runs the request within the same built runtime), scoped to the
    // authed surface: the device-login flow runs its own effects through
    // `useGatekeeperRuntimeLayer`, not `runAuthed`, so its expected 401/400
    // polling responses are untouched. A persistent 401 propagates unchanged so
    // the QueryCache `onError` can redirect to device login.
    runAuthed: (effect, options) => {
      const bootPhase = effect.pipe(
        Effect.retry(unauthorizedRetrySchedule),
        Effect.tap(() =>
          Effect.sync(() => {
            booted = true
          })
        )
      )
      return pipe(booted ? effect : bootPhase, Effect.provide(runtimeLayer), (provided) =>
        Effect.runPromise(provided, options)
      )
    },
    runtimeLayer,
  }
}

export { buildRunAuthed, type ApiTransport }
