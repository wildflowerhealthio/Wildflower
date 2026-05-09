// Side-effect import from the top of `index.ts`; filename matches the Sentry SDK convention.
import { initNodeTelemetryFromEnv } from 'telemetry-node'
import { SERVICE_NAME } from './service-name.ts'

initNodeTelemetryFromEnv({ otel: { serviceName: SERVICE_NAME } })
