import { describe, expect, test } from 'vite-plus/test'
import { configFromEnv, type TelemetryConfig } from './config.ts'
import { mergeConfig } from './merge-config.ts'

const baseCfg: TelemetryConfig = configFromEnv({
  SENTRY_DSN: 'https://k@s.io/1',
  SENTRY_ENVIRONMENT: 'production',
  SENTRY_RELEASE: 'v1.0.0',
  SENTRY_TRACES_SAMPLE_RATE: '0.4',
  SENTRY_PROFILES_SAMPLE_RATE: '0.2',
  OTEL_SERVICE_NAME: 'svc',
  OTEL_SERVICE_VERSION: '1.0.0',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel/v1',
})

describe('mergeConfig', () => {
  test('returns an equivalent config when overrides are omitted', () => {
    expect(mergeConfig(baseCfg)).toEqual(baseCfg)
  })

  test('returns an equivalent config for an empty overrides object', () => {
    expect(mergeConfig(baseCfg, {})).toEqual(baseCfg)
  })

  test('partial sentry overrides are merged field-by-field', () => {
    const merged = mergeConfig(baseCfg, { sentry: { tracesSampleRate: 0.1 } })
    expect(merged.sentry).toEqual({ ...baseCfg.sentry, tracesSampleRate: 0.1 })
  })

  test('partial otel overrides are merged field-by-field', () => {
    const merged = mergeConfig(baseCfg, { otel: { otlpHeaders: { 'x-token': 'abc' } } })
    expect(merged.otel).toEqual({ ...baseCfg.otel, otlpHeaders: { 'x-token': 'abc' } })
  })

  test('debug flag is replaced wholesale (not merged)', () => {
    expect(mergeConfig(baseCfg, { debug: true }).debug).toBe(true)
    expect(mergeConfig({ ...baseCfg, debug: true }, { debug: false }).debug).toBe(false)
  })

  test('overrides cascade across all three groups in a single call', () => {
    const merged = mergeConfig(baseCfg, {
      sentry: { dsn: 'override-dsn' },
      otel: { serviceName: 'override-svc' },
      debug: true,
    })
    expect(merged.sentry.dsn).toBe('override-dsn')
    expect(merged.otel.serviceName).toBe('override-svc')
    expect(merged.debug).toBe(true)
    expect(merged.sentry.environment).toBe(baseCfg.sentry.environment)
    expect(merged.otel.otlpEndpoint).toBe(baseCfg.otel.otlpEndpoint)
  })

  test('does not mutate the base config', () => {
    const snapshot = structuredClone(baseCfg)
    mergeConfig(baseCfg, {
      sentry: { dsn: 'override' },
      otel: { serviceName: 'override' },
      debug: true,
    })
    expect(baseCfg).toEqual(snapshot)
  })
})
