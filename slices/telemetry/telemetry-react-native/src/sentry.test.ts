import type { TelemetryConfig } from 'telemetry-core'

// `@sentry/react-native` ships native bindings; stub the SDK so module
// load and `Sentry.init` are safe under a Node Jest runtime.
jest.mock('@sentry/react-native', () => ({
  __esModule: true,
  init: jest.fn(),
  getClient: jest.fn(() => undefined),
}))

jest.mock('@sentry/opentelemetry', () => ({
  __esModule: true,
  setupEventContextTrace: jest.fn(),
}))

import { initSentryReactNative, Sentry } from './sentry.ts'

const disabledConfig: TelemetryConfig = {
  sentry: {
    dsn: '',
    environment: 'test',
    release: '',
    tracesSampleRate: 1,
    profilesSampleRate: 0,
  },
  otel: {
    serviceName: 'svc',
    serviceVersion: '0.0.0',
    otlpEndpoint: null,
    otlpHeaders: null,
  },
  debug: false,
}

describe('sentry.ts', () => {
  it('re-exports the Sentry SDK namespace', () => {
    expect(Sentry).toBeDefined()
    expect(typeof Sentry.init).toBe('function')
  })

  it('initSentryReactNative is a function', () => {
    expect(typeof initSentryReactNative).toBe('function')
  })

  it('initSentryReactNative returns false when Sentry is disabled (empty DSN)', () => {
    expect(initSentryReactNative(disabledConfig)).toBe(false)
  })
})
