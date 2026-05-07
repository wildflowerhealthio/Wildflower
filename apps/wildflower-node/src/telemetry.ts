import { nodeTelemetryLayerFromEnv } from 'telemetry-node'

export const TelemetryLive = nodeTelemetryLayerFromEnv({
  otel: { serviceName: 'wildflower-node' },
})
