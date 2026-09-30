import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'
import { configFromEnv, type TelemetryConfig } from './config.ts'
import type { TelemetryConsent } from './consent.ts'
import { telemetryConfigFor } from './consented-config.ts'

const baseConfig: TelemetryConfig = configFromEnv({
  SENTRY_DSN: 'https://key@sentry.example/1',
  SENTRY_ENVIRONMENT: 'production',
  SENTRY_RELEASE: 'abc123',
  SENTRY_TRACES_SAMPLE_RATE: '0.25',
  SENTRY_PROFILES_SAMPLE_RATE: '0.5',
  OTEL_SERVICE_NAME: 'medications-app',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces',
})

const consentWith = (switches: {
  readonly crashReports: boolean
  readonly performance: boolean
}): TelemetryConsent => ({ version: 1, decidedAt: '2026-09-29T12:00:00.000Z', ...switches })

describe('telemetryConfigFor', () => {
  test.each([
    { label: 'undecided', consent: undefined },
    { label: 'declined', consent: consentWith({ crashReports: false, performance: false }) },
  ])('turns every sink off when $label', ({ consent }) => {
    const consentedConfig = telemetryConfigFor(consent, baseConfig)

    expect(consentedConfig.sentry.dsn).toBe('')
    expect(consentedConfig.sentry.tracesSampleRate).toBe(0)
    expect(consentedConfig.sentry.profileSessionSampleRate).toBe(0)
    expect(consentedConfig.otel.otlpEndpoint).toBeNull()
  })

  test('keeps the DSN and turns tracing off with crash reports only', () => {
    const consentedConfig = telemetryConfigFor(
      consentWith({ crashReports: true, performance: false }),
      baseConfig
    )

    expect(consentedConfig.sentry.dsn).toBe(baseConfig.sentry.dsn)
    expect(consentedConfig.sentry.tracesSampleRate).toBe(0)
    expect(consentedConfig.otel.otlpEndpoint).toBeNull()
  })

  test('keeps the DSN and the sample rate with performance only', () => {
    const consentedConfig = telemetryConfigFor(
      consentWith({ crashReports: false, performance: true }),
      baseConfig
    )

    expect(consentedConfig.sentry.dsn).toBe(baseConfig.sentry.dsn)
    expect(consentedConfig.sentry.tracesSampleRate).toBe(0.25)
  })

  test('property: never samples profiles or exports over OTLP, and keeps every field outside the switches', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (crashReports, performance) => {
        const consentedConfig = telemetryConfigFor(
          consentWith({ crashReports, performance }),
          baseConfig
        )

        expect(consentedConfig.sentry.profileSessionSampleRate).toBe(0)
        expect(consentedConfig.otel.otlpEndpoint).toBeNull()
        expect(consentedConfig.sentry.environment).toBe(baseConfig.sentry.environment)
        expect(consentedConfig.sentry.release).toBe(baseConfig.sentry.release)
        expect(consentedConfig.otel.serviceName).toBe(baseConfig.otel.serviceName)
        expect(consentedConfig.debug).toBe(baseConfig.debug)
      }),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })
})
