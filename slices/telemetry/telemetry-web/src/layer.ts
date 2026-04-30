import {
  getGlobalTracer,
  initClientTelemetry,
  makeClientTelemetryLayer,
  type SentryAdapter,
  type TelemetryConfig,
} from 'telemetry-core'
import { initSentryWeb, Sentry } from './sentry.ts'

const sentryAdapter: SentryAdapter = {
  init: initSentryWeb,
  getClient: () => Sentry.getClient(),
}

const initWebTelemetry = (config: TelemetryConfig): ReturnType<typeof initClientTelemetry> =>
  initClientTelemetry(config, sentryAdapter)

const makeWebTelemetryLayer = (
  config: TelemetryConfig
): ReturnType<typeof makeClientTelemetryLayer> => makeClientTelemetryLayer(config, sentryAdapter)

export { getGlobalTracer, initWebTelemetry, makeWebTelemetryLayer }
