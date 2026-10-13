import type { HttpClient } from '@effect/platform'
import { AppsRouterContext } from '@wildflowerhealthio/apps-react'
import { DatabasesRouterContext } from '@wildflowerhealthio/databases-react'
import { FhirR4ResourcesRouterContext } from '@wildflowerhealthio/fhir-r4-react'
import { GatekeeperRouterContext } from '@wildflowerhealthio/gatekeeper-react'
import { RequestLogRouterContext } from '@wildflowerhealthio/request-log-react'
import { Effect, Layer, pipe } from 'effect'

import { unauthorizedRetrySchedule } from './retry-policy.ts'
import type { RunAuthed, RuntimeLayer } from './router-context.ts'

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
 * @param apiTransport - The API server's transport, which every slice's
 *   client (FHIR's included: the server serves it at its root) sends through.
 *   The entry builds it (`app-query-runtime.ts`'s `apiTransport`), so it
 *   decides the origin and how a request authenticates.
 * @param effectTelemetryLayer - The entry's Effect telemetry layer, merged
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
      GatekeeperRouterContext.sliceRuntimeLayer,
      FhirR4ResourcesRouterContext.sliceRuntimeLayer,
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

export { buildRunAuthed }
