import { StackContextManager } from '@opentelemetry/sdk-trace-web'
import {
  getGlobalTracer,
  initClientTelemetry,
  makeClientTelemetryLayer,
  type SentryAdapter,
  type TelemetryConfig,
} from 'telemetry-core'
import { initSentryWeb, type InitSentryWebOptions, Sentry } from './sentry.ts'

/** The adapter `telemetry-core` initializes Sentry through, with `sentryOptions` added to `Sentry.init`. */
const sentryAdapterWith = (sentryOptions: InitSentryWebOptions): SentryAdapter => ({
  init: (config) => initSentryWeb(config, sentryOptions),
  getClient: () => Sentry.getClient(),
})

/**
 * Builds the browser's synchronous OTel `ContextManager` for
 * `telemetry-core` to install globally.
 *
 * @remarks
 * `StackContextManager` keeps the active context on a plain stack rather
 * than an async-local store — the synchronous shape
 * {@link initClientTelemetry} documents as load-bearing. It lives here
 * because `@opentelemetry/sdk-trace-web` is browser-targeted and the pure
 * core layer takes no platform SDKs.
 */
const createWebContextManager = (): StackContextManager => new StackContextManager()

/**
 * Eagerly initialize Sentry and the global OTel tracer provider for the
 * browser.
 *
 * @param sentryOptions - Added to the `Sentry.init` options `config` sets
 */
const initWebTelemetry = (
  config: TelemetryConfig,
  sentryOptions: InitSentryWebOptions = {}
): ReturnType<typeof initClientTelemetry> =>
  initClientTelemetry(config, sentryAdapterWith(sentryOptions), createWebContextManager)

const makeWebTelemetryLayer = (
  config: TelemetryConfig
): ReturnType<typeof makeClientTelemetryLayer> =>
  makeClientTelemetryLayer(config, sentryAdapterWith({}), createWebContextManager)

export { getGlobalTracer, initWebTelemetry, makeWebTelemetryLayer }
