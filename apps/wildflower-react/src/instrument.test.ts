import type * as TelemetryWeb from 'telemetry-web'
import { describe, expect, it, vi } from 'vite-plus/test'

// The Tauri entry's telemetry: `wildflower-react/instrument` starts it from the
// build's env on import, without asking. Stubbed at the module boundary so the
// test reads back that, and how, it started.
const { initWebTelemetryFromEnvMock } = vi.hoisted(() => ({
  initWebTelemetryFromEnvMock: vi.fn<typeof TelemetryWeb.initWebTelemetryFromEnv>(),
}))
vi.mock('telemetry-web', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryWeb>()),
  initWebTelemetryFromEnv: initWebTelemetryFromEnvMock,
}))

describe('instrument (the Tauri entry’s telemetry)', () => {
  it('should start telemetry from the build’s env as wildflower-react when imported', async () => {
    // Arrange / Act
    await import('./instrument.ts')

    // Assert
    expect(initWebTelemetryFromEnvMock).toHaveBeenCalledTimes(1)
    expect(initWebTelemetryFromEnvMock).toHaveBeenCalledWith({
      otel: { serviceName: 'wildflower-react' },
    })
  })
})
