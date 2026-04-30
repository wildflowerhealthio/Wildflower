import {
  configFromEnv,
  mergeConfig,
  type TelemetryConfig,
  type TelemetryConfigOverrides,
} from 'telemetry-core'
import { getGlobalTracer, initWebTelemetry, makeWebTelemetryLayer } from './layer.ts'

/**
 * Read VITE_*-prefixed env vars from `import.meta.env` (inlined by Vite at
 * build time) and apply any caller-provided overrides.
 */
const configFromViteEnv = (overrides?: TelemetryConfigOverrides): TelemetryConfig =>
  mergeConfig(
    configFromEnv(import.meta.env as Readonly<Record<string, string | undefined>>, 'VITE_'),
    overrides
  )

/**
 * Convenience: eagerly initialize telemetry from `import.meta.env` (VITE_*
 * prefix). Call this at the very top of the app entry, before launching the
 * Effect runtime.
 */
const initWebTelemetryFromEnv = (
  overrides?: TelemetryConfigOverrides
): ReturnType<typeof initWebTelemetry> => initWebTelemetry(configFromViteEnv(overrides))

const webTelemetryLayerFromEnv = (
  overrides?: TelemetryConfigOverrides
): ReturnType<typeof makeWebTelemetryLayer> => makeWebTelemetryLayer(configFromViteEnv(overrides))

export {
  getLivestoreOtelOptions,
  injectActiveOtelContext,
  injectActiveOtelContextWhenReady,
  whenOtelProviderReady,
} from 'telemetry-core/livestore'
export {
  getGlobalTracer,
  initWebTelemetry,
  initWebTelemetryFromEnv,
  makeWebTelemetryLayer,
  webTelemetryLayerFromEnv,
}
export { initSentryWeb, Sentry } from './sentry.ts'
