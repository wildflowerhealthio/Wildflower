import { setupEventContextTrace } from '@sentry/opentelemetry'
import * as Sentry from '@sentry/react-native'
import { isSentryEnabled, type TelemetryConfig } from 'telemetry-core'

let initialized = false

const resolveRelease = (raw: string): string | undefined => {
  if (raw === '') return undefined
  return raw
}

/**
 * Initialize the Sentry React Native SDK. We do not disable any OTel bits
 * here because `@sentry/react-native` does not register a TracerProvider —
 * we own that via `@opentelemetry/sdk-trace-base`. Safe to call repeatedly.
 *
 * Always calls `Sentry.init` — in `enabled: false` mode when no DSN is
 * configured — so unconditional `Sentry.wrap` calls in app entry points
 * don't trigger the "wrap was called before init" warning. Returns
 * `true` only when Sentry is actually enabled (DSN present).
 */
const initSentryReactNative = (config: TelemetryConfig): boolean => {
  if (initialized) return isSentryEnabled(config)

  if (!isSentryEnabled(config)) {
    // oxlint-disable-next-line no-console -- intentional dev-time hint
    console.warn(
      'telemetry-react-native: EXPO_PUBLIC_SENTRY_DSN is not set; initializing Sentry in disabled mode. ' +
        'See apps/wildflower-expo/.env.example to configure.'
    )
    Sentry.init({ enabled: false })
    initialized = true
    return false
  }

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

export { initSentryReactNative, Sentry }
