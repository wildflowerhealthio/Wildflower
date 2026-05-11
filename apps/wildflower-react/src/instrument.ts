import { initWebTelemetryFromEnv } from 'telemetry-web'

initWebTelemetryFromEnv({ otel: { serviceName: 'wildflower-react' } })
