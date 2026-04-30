import {
  getGlobalTracer,
  initClientTelemetry,
  makeClientTelemetryLayer,
  type SentryAdapter,
  type TelemetryConfig,
} from 'telemetry-core'
import { initSentryReactNative, Sentry } from './sentry.ts'

const sentryAdapter: SentryAdapter = {
  init: initSentryReactNative,
  getClient: () => Sentry.getClient(),
}

const initReactNativeTelemetry = (
  config: TelemetryConfig
): ReturnType<typeof initClientTelemetry> => initClientTelemetry(config, sentryAdapter)

const makeReactNativeTelemetryLayer = (
  config: TelemetryConfig
): ReturnType<typeof makeClientTelemetryLayer> => makeClientTelemetryLayer(config, sentryAdapter)

export { getGlobalTracer, initReactNativeTelemetry, makeReactNativeTelemetryLayer }
