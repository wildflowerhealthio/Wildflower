// Boots Sentry + OpenTelemetry before any other module loads. Imported for
// its side effect from the top of `index.ts`. Convention name matches the
// Sentry Node SDK wizard output.
import { initNodeTelemetryFromEnv } from 'telemetry-node'

initNodeTelemetryFromEnv({ otel: { serviceName: 'wildflower-node' } })
