import { Layer } from 'effect'
import { configFromEnv } from 'telemetry-core'
import { describe, expect, test } from 'vite-plus/test'
import { initWebTelemetry, makeWebTelemetryLayer } from './layer.ts'

describe('initWebTelemetry', () => {
  test('returns undefined when telemetry is fully disabled', () => {
    expect(initWebTelemetry(configFromEnv({}))).toBeUndefined()
  })
})

describe('makeWebTelemetryLayer', () => {
  test('returns Layer.empty when telemetry is fully disabled', () => {
    expect(makeWebTelemetryLayer(configFromEnv({}))).toBe(Layer.empty)
  })
})
