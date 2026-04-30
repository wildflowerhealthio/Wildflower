import * as Sentry from '@sentry/node'
import { setupEventContextTrace } from '@sentry/opentelemetry'
import { isSentryEnabled, type TelemetryConfig } from 'telemetry-core'

let initialized = false

const resolveRelease = (raw: string): string | undefined => {
  if (raw === '') return undefined
  return raw
}

/**
 * Initialize the Sentry Node SDK with OTel setup skipped — the Effect
 * OpenTelemetry layer owns the TracerProvider. Safe to call repeatedly;
 * subsequent calls are no-ops. Returns true iff Sentry is actually active.
 */
const initSentryNode = (config: TelemetryConfig): boolean => {
  if (!isSentryEnabled(config)) return false
  if (initialized) return true

  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    release: resolveRelease(config.sentry.release),
    tracesSampleRate: config.sentry.tracesSampleRate,
    profilesSampleRate: config.sentry.profilesSampleRate,
    debug: config.debug,
    skipOpenTelemetrySetup: true,
    registerEsmLoaderHooks: false,
  })

  const client = Sentry.getClient()
  if (client !== undefined) {
    setupEventContextTrace(client)
  }

  initialized = true
  return true
}

export { initSentryNode, Sentry }
