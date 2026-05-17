jest.mock('@sentry/react-native', () => ({
  __esModule: true,
  init: jest.fn(),
  getClient: jest.fn(() => undefined),
}))

jest.mock('@sentry/opentelemetry', () => ({
  __esModule: true,
  setupEventContextTrace: jest.fn(),
  SentryPropagator: jest.fn(),
  SentrySampler: jest.fn(),
  SentrySpanProcessor: jest.fn(),
}))

import {
  getGlobalTracer,
  getLivestoreOtelOptions,
  initReactNativeTelemetry,
  initReactNativeTelemetryFromEnv,
  initSentryReactNative,
  injectActiveOtelContext,
  injectActiveOtelContextWhenReady,
  makeReactNativeTelemetryLayer,
  reactNativeTelemetryLayerFromEnv,
  Sentry,
  whenOtelProviderReady,
} from './index.ts'

describe('index.ts barrel exports', () => {
  it.each([
    ['getGlobalTracer', getGlobalTracer],
    ['getLivestoreOtelOptions', getLivestoreOtelOptions],
    ['initReactNativeTelemetry', initReactNativeTelemetry],
    ['initReactNativeTelemetryFromEnv', initReactNativeTelemetryFromEnv],
    ['initSentryReactNative', initSentryReactNative],
    ['injectActiveOtelContext', injectActiveOtelContext],
    ['injectActiveOtelContextWhenReady', injectActiveOtelContextWhenReady],
    ['makeReactNativeTelemetryLayer', makeReactNativeTelemetryLayer],
    ['reactNativeTelemetryLayerFromEnv', reactNativeTelemetryLayerFromEnv],
    ['whenOtelProviderReady', whenOtelProviderReady],
  ])('exports %s as a function', (_name, value) => {
    expect(typeof value).toBe('function')
  })

  it('re-exports the Sentry SDK namespace', () => {
    expect(Sentry).toBeDefined()
    expect(typeof Sentry.init).toBe('function')
  })
})

describe('env-driven entrypoints', () => {
  // Snapshot/restore the EXPO_PUBLIC_* keys these helpers read so a stray
  // value in the process env doesn't flip telemetry from disabled to enabled
  // (which would mutate telemetry-core's module-level `registered` state).
  const KEYS = [
    'EXPO_PUBLIC_SENTRY_DSN',
    'EXPO_PUBLIC_SENTRY_ENVIRONMENT',
    'EXPO_PUBLIC_SENTRY_RELEASE',
    'EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE',
    'EXPO_PUBLIC_SENTRY_PROFILES_SAMPLE_RATE',
    'EXPO_PUBLIC_OTEL_SERVICE_NAME',
    'EXPO_PUBLIC_OTEL_SERVICE_VERSION',
    'EXPO_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT',
    'EXPO_PUBLIC_OTEL_DEBUG',
  ] as const

  let originals: Partial<Record<(typeof KEYS)[number], string | undefined>> = {}

  beforeEach(() => {
    originals = {}
    for (const k of KEYS) {
      originals[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of KEYS) {
      const v = originals[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('initReactNativeTelemetryFromEnv returns undefined when no EXPO_PUBLIC_* vars are set', () => {
    expect(initReactNativeTelemetryFromEnv()).toBeUndefined()
  })

  it('reactNativeTelemetryLayerFromEnv returns a Layer when no EXPO_PUBLIC_* vars are set', () => {
    const layer = reactNativeTelemetryLayerFromEnv()
    expect(layer).toBeDefined()
    expect(typeof layer).toBe('object')
  })
})
