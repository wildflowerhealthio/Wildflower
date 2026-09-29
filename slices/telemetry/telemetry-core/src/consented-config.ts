import type { TelemetryConfig } from './config.ts'
import type { TelemetryConsent } from './consent.ts'
import { mergeConfig } from './merge-config.ts'

/**
 * `baseConfig` narrowed to what the visitor consented to.
 *
 * @param consent - The visitor's answer, or `undefined` while they have not
 *   given one
 * @param baseConfig - The app's build-time config
 * @returns A config whose sinks are only those `consent` allows:
 *   - the Sentry DSN stays while either switch is on, and is emptied otherwise
 *   - `tracesSampleRate` and the OTLP endpoint stay only with `performance`;
 *     otherwise the rate is 0 and the endpoint absent
 *   - `profileSessionSampleRate` is always 0
 *
 * @remarks
 * Both switches report through the same Sentry project, so the DSN follows
 * either of them; keeping error events out when only `performance` is on is
 * the job of the SDK's `beforeSend` hook, which `telemetry-web` installs.
 * Profiling is outside both switches, so it is never sampled.
 */
const telemetryConfigFor = (
  consent: TelemetryConsent | undefined,
  baseConfig: TelemetryConfig
): TelemetryConfig => {
  const crashReports = consent?.crashReports ?? false
  const performance = consent?.performance ?? false
  return mergeConfig(baseConfig, {
    sentry: {
      dsn: crashReports || performance ? baseConfig.sentry.dsn : '',
      tracesSampleRate: performance ? baseConfig.sentry.tracesSampleRate : 0,
      profileSessionSampleRate: 0,
    },
    otel: {
      otlpEndpoint: performance ? baseConfig.otel.otlpEndpoint : null,
    },
  })
}

export { telemetryConfigFor }
