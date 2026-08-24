import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { AppsRouterContext } from 'apps-react'
import { CollectorRouterContext } from 'collector-react'
import { DatabasesRouterContext } from 'databases-react'
import { Effect, Layer, pipe } from 'effect'
import { FhirR4ResourcesRouterContext } from 'fhir-r4-react'
import { FhirResourcesApiPrefix } from 'fhir-r4/http-api-definition'
import { GatekeeperRouterContext } from 'gatekeeper-react'
import { TunnelRouterContext } from 'tunnel-react'

import { webTelemetryLayerFromEnv } from 'telemetry-web'
import { prependApiBaseUrl } from './bridges/prepend-api-base-url.ts'
import { unauthorizedRetrySchedule } from './retry-policy.ts'
import type { RunAuthed, RuntimeLayer } from './router-context.ts'

/**
 * Cross-origin cookie-auth `RequestInit` for the platform `fetch`. On Tauri the
 * page origin (`tauri://localhost` in a build, the dev server in dev) is
 * cross-site to the loopback API origin (`http://127.0.0.1:<port>`), so the
 * host-planted `wf_auth` cookie only rides fetches made in credentialed mode.
 * `FetchHttpClient` reads this tag from the **request-time** fiber context (not
 * at layer build), so it's merged into the runtime layer below as an extra
 * service — the same way the telemetry services already ride along. Same-origin
 * web/embedded already send the cookie; `credentials: 'include'` is a superset,
 * so this is inert there.
 */
const credentialedFetchLayer = Layer.succeed(FetchHttpClient.RequestInit, {
  credentials: 'include',
})

/**
 * Builds the page-lifetime runtime layer + authed runner. Clients are
 * tokenless — auth rides the `HttpOnly` `wf_auth` cookie that the
 * platform `fetch` sends with same-origin requests.
 *
 * The `beforeLoad` auth gate (not the loaders) guarantees the auth
 * signal is ready before any authed loader runs, so there's no
 * `isTokenReady` reader here — loaders are plain `ensureQueryData`.
 */
const buildRunAuthed = (
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>
): {
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
} => {
  const baseRuntimeLayer = Layer.mergeAll(
    httpClientLayer,
    webTelemetryLayerFromEnv(),
    credentialedFetchLayer
  )
  const runtimeLayer: RuntimeLayer = Layer.provideMerge(
    Layer.mergeAll(
      TunnelRouterContext.sliceRuntimeLayer,
      AppsRouterContext.sliceRuntimeLayer,
      GatekeeperRouterContext.sliceRuntimeLayer,
      CollectorRouterContext.sliceRuntimeLayer,
      // The FHIR slice's typed client emits base-relative paths (`/Patient`) now
      // that `FhirResourcesApi` no longer bakes in the mount prefix — so it needs
      // an *addressed* transport that re-applies `/fhir-r4`, while every other
      // slice keeps the shared `baseRuntimeLayer` transport. Requests flow:
      // client `/Patient` → this wrapper `/fhir-r4/Patient` (still relative) →
      // `httpClientLayer` (which in Tauri prepends the API origin) →
      // `{origin}/fhir-r4/Patient`. The credentialed-fetch tag is read from the
      // request-time fiber (which `runAuthed` provides `runtimeLayer` to), so the
      // `wf_auth` cookie still rides these reads despite the separate transport.
      FhirR4ResourcesRouterContext.sliceRuntimeLayer.pipe(
        Layer.provide(prependApiBaseUrl(httpClientLayer, FhirResourcesApiPrefix))
      ),
      DatabasesRouterContext.sliceRuntimeLayer
    ),
    baseRuntimeLayer
  )
  // The boot-race retry only covers the *boot window* — the gap between the
  // page loading and the just-issued `wf_auth` cookie landing in the jar. Once
  // any authed request has succeeded, the cookie is demonstrably present, so
  // `booted` latches on and later 401s skip the retry entirely: a genuine
  // session expiry then propagates immediately (no 4×150ms re-send per query)
  // and the QueryCache `onError` redirect fires without delay. Without the
  // latch the retry fired on every 401 for the page's whole lifetime — the
  // steady-state cost the reviewer flagged.
  let booted = false
  return {
    // The retry sits *inside* the runner (before `provide`, so each re-send
    // re-runs the request within the same built runtime), scoped to the
    // cookie-authed surface: the device-login flow runs its own effects through
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

export { buildRunAuthed, credentialedFetchLayer }
