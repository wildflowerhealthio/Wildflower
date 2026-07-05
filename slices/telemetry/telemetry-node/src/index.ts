import {
  configFromEnv,
  mergeConfig,
  type TelemetryConfig,
  type TelemetryConfigOverrides,
} from 'telemetry-core'
import { getGlobalTracer, initNodeTelemetry, makeNodeTelemetryLayer } from './layer.ts'

const configFromProcessEnv = (overrides?: TelemetryConfigOverrides): TelemetryConfig =>
  mergeConfig(configFromEnv(process.env), overrides)

/**
 * Convenience: eagerly initialize telemetry from `process.env`. Call this at
 * the very top of the app entry, before creating Livestore or launching the
 * Effect runtime.
 */
const initNodeTelemetryFromEnv = (
  overrides?: TelemetryConfigOverrides
): ReturnType<typeof initNodeTelemetry> => initNodeTelemetry(configFromProcessEnv(overrides))

const nodeTelemetryLayerFromEnv = (
  overrides?: TelemetryConfigOverrides
): ReturnType<typeof makeNodeTelemetryLayer> =>
  makeNodeTelemetryLayer(configFromProcessEnv(overrides))

export { getLivestoreOtelOptions } from 'telemetry-core/livestore'
export {
  getGlobalTracer,
  initNodeTelemetry,
  initNodeTelemetryFromEnv,
  makeNodeTelemetryLayer,
  nodeTelemetryLayerFromEnv,
}
export { initSentryNode, Sentry } from './sentry.ts'
