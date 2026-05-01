import { configFromEnv } from 'telemetry-core'
import { describe, expect, test } from 'vite-plus/test'
import { initSentryWeb } from './sentry.ts'

describe('initSentryWeb', () => {
  test('returns false for a config with an empty DSN without invoking the SDK', () => {
    expect(initSentryWeb(configFromEnv({}))).toBe(false)
  })

  test('returns false even when OTLP is configured but Sentry DSN is empty', () => {
    const cfg = configFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel/v1' })
    expect(initSentryWeb(cfg)).toBe(false)
  })
})
