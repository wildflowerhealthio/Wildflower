import type { TelemetryConfig, TelemetryConfigOverrides } from './config.ts'

const mergeConfig = (
  base: TelemetryConfig,
  overrides?: TelemetryConfigOverrides
): TelemetryConfig => ({
  sentry: { ...base.sentry, ...overrides?.sentry },
  otel: { ...base.otel, ...overrides?.otel },
  debug: overrides?.debug ?? base.debug,
})

export { mergeConfig }
