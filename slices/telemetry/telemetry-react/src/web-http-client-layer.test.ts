import { HttpClient } from '@effect/platform'
import { Effect, Layer } from 'effect'
import { describe, expect, test, vi } from 'vite-plus/test'

// Building the web telemetry layer is what starts telemetry, so it is the
// collaborator stubbed here: the test reads back when it was built.
const { webTelemetryLayerFromEnvMock } = vi.hoisted(() => ({
  webTelemetryLayerFromEnvMock: vi.fn(() => Layer.empty),
}))
vi.mock('telemetry-web', () => ({ webTelemetryLayerFromEnv: webTelemetryLayerFromEnvMock }))

describe('webHttpClientLayer', () => {
  test('starts no telemetry when imported, only when the layer is built', async () => {
    const { webHttpClientLayer } = await import('./web-http-client-layer.ts')
    expect(webTelemetryLayerFromEnvMock).not.toHaveBeenCalled()

    await Effect.runPromise(
      Effect.provide(
        Effect.map(HttpClient.HttpClient, () => undefined),
        webHttpClientLayer
      )
    )

    expect(webTelemetryLayerFromEnvMock).toHaveBeenCalledTimes(1)
  })
})
