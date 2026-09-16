import { context, createContextKey, ROOT_CONTEXT } from '@opentelemetry/api'
import { Layer } from 'effect'
import { configFromEnv } from 'telemetry-core'
import { describe, expect, test } from 'vite-plus/test'
import { initWebTelemetry, makeWebTelemetryLayer } from './layer.ts'

const probeKey = createContextKey('telemetry-web/layer.test')

describe('initWebTelemetry', () => {
  test('returns undefined when telemetry is fully disabled', () => {
    expect(initWebTelemetry(configFromEnv({}))).toBeUndefined()
  })

  test('installs a ContextManager that round-trips the active context', () => {
    initWebTelemetry(configFromEnv({}))

    // The default `NoopContextManager` reports `ROOT_CONTEXT` inside `with`,
    // so this only holds once the browser `StackContextManager` this package
    // injects into `telemetry-core` is the globally installed one — the
    // property `@effect/opentelemetry`'s per-fiber-step bridge depends on.
    const scoped = ROOT_CONTEXT.setValue(probeKey, 'scoped')
    expect(context.with(scoped, () => context.active().getValue(probeKey))).toBe('scoped')
  })
})

describe('makeWebTelemetryLayer', () => {
  test('returns Layer.empty when telemetry is fully disabled', () => {
    expect(makeWebTelemetryLayer(configFromEnv({}))).toBe(Layer.empty)
  })
})
