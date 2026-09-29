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
 *   - `tracesSampleRate` stays only with `performance`; otherwise it is 0
 *   - `profileSessionSampleRate` is always 0
 *   - the OTLP endpoint is always absent
 *
 * @remarks
 * Both switches report through the same Sentry project, so the DSN follows
 * either of them; keeping error events out when only `performance` is on is
 * the job of the SDK's `beforeSend` hook, which `telemetry-web` installs.
 * Profiling is outside both switches, so it is never sampled. The consent
 * dialog names Sentry as where reports go, and spans exported over OTLP pass
 * no scrubbing hook, so no answer turns the OTLP exporter on.
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
    otel: { otlpEndpoint: null },
  })
}

export { telemetryConfigFor }
