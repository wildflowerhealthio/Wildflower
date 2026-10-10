import { setupEventContextTrace } from '@sentry/opentelemetry'
import * as Sentry from '@sentry/react'
import { isSentryEnabled, type TelemetryConfig } from '@wildflowerhealthio/telemetry-core'

let initialized = false

const resolveRelease = (raw: string): string | undefined => {
  if (raw === '') return undefined
  return raw
}

/**
 * The `Sentry.init` options {@link initSentryWeb} takes beyond what
 * `TelemetryConfig` says: the integrations to add to the SDK's defaults, the
 * hooks events pass through before they are sent, and what data the SDK
 * collects alongside them.
 */
type InitSentryWebOptions = Pick<
  Sentry.BrowserOptions,
  'integrations' | 'beforeSend' | 'beforeSendTransaction' | 'dataCollection'
>

/**
 * Initialize the Sentry Browser SDK. We do not disable any OTel bits here
 * because `@sentry/react` does not register a TracerProvider — we own that
 * via `@opentelemetry/sdk-trace-base`. Safe to call repeatedly: only the
 * first call with a DSN initializes the SDK, and later calls keep its options.
 *
 * @param sentryOptions - Added to the `Sentry.init` options `config` sets
 * @returns Whether Sentry is active
 */
const initSentryWeb = (
  config: TelemetryConfig,
  sentryOptions: InitSentryWebOptions = {}
): boolean => {
  if (!isSentryEnabled(config)) return false
  if (initialized) return true

  Sentry.init({
    ...sentryOptions,
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    release: resolveRelease(config.sentry.release),
    tracesSampleRate: config.sentry.tracesSampleRate,
    debug: config.debug,
  })

  const client = Sentry.getClient()
  if (client !== undefined) {
    setupEventContextTrace(client)
  }

  initialized = true
  return true
}

export type { InitSentryWebOptions }
export { initSentryWeb, Sentry }
