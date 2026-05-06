import { initWebTelemetryFromEnv } from 'telemetry-web'

initWebTelemetryFromEnv({ otel: { serviceName: 'gatekeeper-web' } })
