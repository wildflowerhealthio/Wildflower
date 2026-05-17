import { Layer } from 'effect'
import type { TelemetryConfig } from 'telemetry-core'

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
  initReactNativeTelemetry,
  makeReactNativeTelemetryLayer,
} from './layer.ts'

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

describe('layer.ts', () => {
  it('initReactNativeTelemetry is a function', () => {
    expect(typeof initReactNativeTelemetry).toBe('function')
  })

  it('makeReactNativeTelemetryLayer is a function', () => {
    expect(typeof makeReactNativeTelemetryLayer).toBe('function')
  })

  it('getGlobalTracer returns a Tracer with the OTel surface', () => {
    const tracer = getGlobalTracer('telemetry-react-native.test')
    expect(tracer).toBeDefined()
    expect(typeof tracer.startSpan).toBe('function')
    expect(typeof tracer.startActiveSpan).toBe('function')
  })

  it('initReactNativeTelemetry returns undefined when telemetry is disabled', () => {
    // Disabled = no DSN and no OTLP endpoint -> isTelemetryEnabled is false ->
    // initClientTelemetry early-returns without registering a global provider.
    expect(initReactNativeTelemetry(disabledConfig)).toBeUndefined()
  })

  it('makeReactNativeTelemetryLayer returns a Layer when telemetry is disabled', () => {
    const layer = makeReactNativeTelemetryLayer(disabledConfig)
    expect(Layer.isLayer(layer)).toBe(true)
  })
})
