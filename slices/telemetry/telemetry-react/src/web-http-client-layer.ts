import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Layer } from 'effect'
import { webTelemetryLayerFromEnv } from 'telemetry-web'

/**
 * `Layer<HttpClient, never, never>` for browser code: the default
 * `FetchHttpClient.layer` paired with the web-side telemetry layer so
 * every outgoing request emits OTLP spans + Sentry breadcrumbs without
 * the caller having to wire them by hand.
 *
 * Reused by the `useEffectTs` / `useStream` wrappers in this package
 * (they auto-provide it) and by app composition code that manually
 * merges it into a multi-slice client layer.
 *
 * Built eagerly at module load — the layer description is a value, not
 * a running instance, so this is cheap.
 */
const webHttpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never> = Layer.mergeAll(
  FetchHttpClient.layer,
  webTelemetryLayerFromEnv()
).pipe(Layer.provideMerge(FetchHttpClient.layer))

export { webHttpClientLayer }
