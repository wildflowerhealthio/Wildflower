import {
  configFromEnv,
  mergeConfig,
  type TelemetryConfig,
  type TelemetryConfigOverrides,
} from 'telemetry-core'
import {
  getGlobalTracer,
  initReactNativeTelemetry,
  makeReactNativeTelemetryLayer,
} from './layer.ts'

/**
 * Read EXPO_PUBLIC_*-prefixed env vars from `process.env` (inlined by the
 * Expo/Metro bundler at build time) and apply any caller-provided overrides.
 */
const configFromExpoEnv = (overrides?: TelemetryConfigOverrides): TelemetryConfig =>
  mergeConfig(
    configFromEnv(process.env as Readonly<Record<string, string | undefined>>, 'EXPO_PUBLIC_'),
    overrides
  )

/**
 * Convenience: eagerly initialize telemetry from `process.env` (EXPO_PUBLIC_*
 * prefix). Call this at the very top of the app entry, before creating the
 * Livestore store or launching the Effect runtime.
 */
const initReactNativeTelemetryFromEnv = (
  overrides?: TelemetryConfigOverrides
): ReturnType<typeof initReactNativeTelemetry> =>
  initReactNativeTelemetry(configFromExpoEnv(overrides))

const reactNativeTelemetryLayerFromEnv = (
  overrides?: TelemetryConfigOverrides
): ReturnType<typeof makeReactNativeTelemetryLayer> =>
  makeReactNativeTelemetryLayer(configFromExpoEnv(overrides))

export {
  getLivestoreOtelOptions,
  injectActiveOtelContext,
  injectActiveOtelContextWhenReady,
  whenOtelProviderReady,
} from 'telemetry-core/livestore'
export {
  getGlobalTracer,
  initReactNativeTelemetry,
  initReactNativeTelemetryFromEnv,
  makeReactNativeTelemetryLayer,
  reactNativeTelemetryLayerFromEnv,
}
export { initSentryReactNative, Sentry } from './sentry.ts'
