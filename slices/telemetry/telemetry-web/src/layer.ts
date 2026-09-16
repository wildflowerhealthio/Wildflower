import { StackContextManager } from '@opentelemetry/sdk-trace-web'
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

/**
 * Builds the browser's synchronous OTel `ContextManager` for
 * `telemetry-core` to install globally.
 *
 * @remarks
 * `StackContextManager` keeps the active context on a plain stack rather
 * than an async-local store, which is what the `@effect/opentelemetry`
 * bridge needs to round-trip context around each fiber step. It lives
 * here because `@opentelemetry/sdk-trace-web` is browser-targeted and the
 * pure core layer takes no platform SDKs.
 */
const createWebContextManager = (): StackContextManager => new StackContextManager()

const initWebTelemetry = (config: TelemetryConfig): ReturnType<typeof initClientTelemetry> =>
  initClientTelemetry(config, sentryAdapter, createWebContextManager)

const makeWebTelemetryLayer = (
  config: TelemetryConfig
): ReturnType<typeof makeClientTelemetryLayer> =>
  makeClientTelemetryLayer(config, sentryAdapter, createWebContextManager)

export { getGlobalTracer, initWebTelemetry, makeWebTelemetryLayer }
