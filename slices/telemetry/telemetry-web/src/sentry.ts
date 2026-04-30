import { setupEventContextTrace } from '@sentry/opentelemetry'
import * as Sentry from '@sentry/react'
import { isSentryEnabled, type TelemetryConfig } from 'telemetry-core'

let initialized = false

const resolveRelease = (raw: string): string | undefined => {
  if (raw === '') return undefined
  return raw
}

/**
 * Initialize the Sentry Browser SDK. We do not disable any OTel bits here
 * because @sentry/react does not register a TracerProvider — we own that via
 * `@opentelemetry/sdk-trace-base`. Safe to call repeatedly.
 */
const initSentryWeb = (config: TelemetryConfig): boolean => {
  if (!isSentryEnabled(config)) return false
  if (initialized) return true

  Sentry.init({
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

export { initSentryWeb, Sentry }
