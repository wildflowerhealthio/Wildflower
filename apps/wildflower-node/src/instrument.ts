// Side-effect import from the top of `index.ts`; filename matches the Sentry SDK convention.
import { initNodeTelemetryFromEnv } from 'telemetry-node'

initNodeTelemetryFromEnv({ otel: { serviceName: 'wildflower-node' } })
