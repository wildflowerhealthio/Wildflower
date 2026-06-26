import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'
import { configFromEnv, isOtlpEnabled, isSentryEnabled, isTelemetryEnabled } from './config.ts'

describe('configFromEnv', () => {
  test('returns documented defaults for an empty env', () => {
    expect(configFromEnv({})).toEqual({
      sentry: {
        dsn: '',
        environment: 'development',
        release: '',
        tracesSampleRate: 1.0,
        profilesSampleRate: 0,
      },
      otel: {
        serviceName: 'wildflower',
        serviceVersion: '0.0.0',
        otlpEndpoint: null,
        otlpHeaders: null,
      },
      debug: false,
    })
  })

  test.each([{ prefix: '' as const }, { prefix: 'VITE_' as const }])(
    'reads env via "$prefix" prefix',
    ({ prefix }) => {
      const env = {
        [`${prefix}SENTRY_DSN`]: 'https://abc@sentry.io/123',
        [`${prefix}SENTRY_ENVIRONMENT`]: 'staging',
        [`${prefix}SENTRY_RELEASE`]: 'v1.2.3',
        [`${prefix}SENTRY_TRACES_SAMPLE_RATE`]: '0.5',
        [`${prefix}SENTRY_PROFILES_SAMPLE_RATE`]: '0.25',
        [`${prefix}OTEL_SERVICE_NAME`]: 'svc',
        [`${prefix}OTEL_SERVICE_VERSION`]: '9.9.9',
        [`${prefix}OTEL_EXPORTER_OTLP_ENDPOINT`]: 'https://otel.example/v1',
        [`${prefix}OTEL_DEBUG`]: 'true',
      }
      expect(configFromEnv(env, prefix)).toEqual({
        sentry: {
          dsn: 'https://abc@sentry.io/123',
          environment: 'staging',
          release: 'v1.2.3',
          tracesSampleRate: 0.5,
          profilesSampleRate: 0.25,
        },
        otel: {
          serviceName: 'svc',
          serviceVersion: '9.9.9',
          otlpEndpoint: 'https://otel.example/v1',
          otlpHeaders: null,
        },
        debug: true,
      })
    }
  )

  test.each([
    { raw: undefined, label: 'undefined' },
    { raw: '', label: 'empty string' },
    { raw: 'not-a-number', label: 'non-numeric' },
    { raw: 'NaN', label: 'NaN' },
    { raw: 'Infinity', label: 'Infinity' },
  ])('falls back tracesSampleRate to 1.0 when raw is $label', ({ raw }) => {
    expect(configFromEnv({ SENTRY_TRACES_SAMPLE_RATE: raw }).sentry.tracesSampleRate).toBe(1.0)
  })

  test('parses zero and negative sample rates verbatim', () => {
    const cfg = configFromEnv({
      SENTRY_TRACES_SAMPLE_RATE: '0',
      SENTRY_PROFILES_SAMPLE_RATE: '-1',
    })
    expect(cfg.sentry.tracesSampleRate).toBe(0)
    expect(cfg.sentry.profilesSampleRate).toBe(-1)
  })

  test.each([
    { raw: undefined, label: 'undefined' },
    { raw: '', label: 'empty string' },
    { raw: '   ', label: 'whitespace only' },
  ])('coerces otlpEndpoint to null when raw is $label', ({ raw }) => {
    expect(configFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: raw }).otel.otlpEndpoint).toBeNull()
  })

  test('trims surrounding whitespace from otlpEndpoint', () => {
    const cfg = configFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: '  https://otel/v1  ' })
    expect(cfg.otel.otlpEndpoint).toBe('https://otel/v1')
  })

  test.each([
    { raw: 'true', expected: true },
    { raw: 'false', expected: false },
    { raw: 'TRUE', expected: false },
    { raw: '1', expected: false },
    { raw: undefined, expected: false },
  ])('debug flag is true only on the exact string "true" (raw=$raw)', ({ raw, expected }) => {
    expect(configFromEnv({ OTEL_DEBUG: raw }).debug).toBe(expected)
  })

  test('property: a configured prefix never reads keys from a different prefix', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (bareDsn, viteDsn) => {
        const env = {
          SENTRY_DSN: bareDsn,
          VITE_SENTRY_DSN: viteDsn,
        }
        expect(configFromEnv(env, '').sentry.dsn).toBe(bareDsn)
        expect(configFromEnv(env, 'VITE_').sentry.dsn).toBe(viteDsn)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('isSentryEnabled', () => {
  test('false when DSN is empty', () => {
    expect(isSentryEnabled(configFromEnv({}))).toBe(false)
  })

  test('true when DSN is non-empty', () => {
    expect(isSentryEnabled(configFromEnv({ SENTRY_DSN: 'https://x@s.io/1' }))).toBe(true)
  })
})

describe('isOtlpEnabled', () => {
  test('false when endpoint is unset', () => {
    expect(isOtlpEnabled(configFromEnv({}))).toBe(false)
  })

  test('true when endpoint is set', () => {
    const cfg = configFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel/v1' })
    expect(isOtlpEnabled(cfg)).toBe(true)
  })

  test('property: tracks the trimmed endpoint string presence', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const cfg = configFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: raw })
        expect(isOtlpEnabled(cfg)).toBe(raw.trim().length > 0)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('isTelemetryEnabled', () => {
  test('false when neither sink is configured', () => {
    expect(isTelemetryEnabled(configFromEnv({}))).toBe(false)
  })

  test('true when only Sentry is configured', () => {
    expect(isTelemetryEnabled(configFromEnv({ SENTRY_DSN: 'https://x@s.io/1' }))).toBe(true)
  })

  test('true when only OTLP is configured', () => {
    expect(
      isTelemetryEnabled(configFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel/v1' }))
    ).toBe(true)
  })

  test('true when both are configured', () => {
    expect(
      isTelemetryEnabled(
        configFromEnv({
          SENTRY_DSN: 'https://x@s.io/1',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel/v1',
        })
      )
    ).toBe(true)
  })
})
