import { Layer } from 'effect'
import { configFromEnv } from 'telemetry-core'
import { describe, expect, test } from 'vite-plus/test'
import { initNodeTelemetry, makeNodeTelemetryLayer } from './layer.ts'

describe('initNodeTelemetry', () => {
  test('returns undefined when telemetry is fully disabled', () => {
    expect(initNodeTelemetry(configFromEnv({}))).toBeUndefined()
  })
})

describe('makeNodeTelemetryLayer', () => {
  test('returns Layer.empty when telemetry is fully disabled', () => {
    expect(makeNodeTelemetryLayer(configFromEnv({}))).toBe(Layer.empty)
  })
})
