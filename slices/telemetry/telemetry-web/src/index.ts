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
 *
 * @remarks
 * A consented app builds the config it hands `initConsentedTelemetry` here,
 * overriding the DSN with its own project's.
 */
const configFromViteEnv = (overrides?: TelemetryConfigOverrides): TelemetryConfig =>
  mergeConfig(configFromEnv(import.meta.env, 'VITE_'), overrides)

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
  configFromViteEnv,
  getGlobalTracer,
  initWebTelemetry,
  initWebTelemetryFromEnv,
  makeWebTelemetryLayer,
  webTelemetryLayerFromEnv,
}
export type { InitConsentedTelemetryOptions, TelemetryTags } from './consented.ts'
export { initConsentedTelemetry, setFhirServerHost } from './consented.ts'
export type { InitSentryWebOptions } from './sentry.ts'
export { initSentryWeb, Sentry } from './sentry.ts'
