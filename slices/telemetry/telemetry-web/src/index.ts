import {
  configFromEnv,
  mergeConfig,
  type TelemetryConfig,
  type TelemetryConfigOverrides,
} from '@wildflowerhealthio/telemetry-core'
import { getGlobalTracer, initWebTelemetry } from './layer.ts'

/**
 * Read VITE_*-prefixed env vars from `import.meta.env` (inlined by Vite at
 * build time) and apply any caller-provided overrides.
 *
 * @remarks
 * A consented app builds the config it hands `initConsentedTelemetry` here,
 * overriding the DSN with its own project's.
 */
const configFromViteEnv = (overrides?: TelemetryConfigOverrides): TelemetryConfig =>
  mergeConfig(configFromEnv(import.meta.env, 'VITE_'), overrides)

export { configFromViteEnv, getGlobalTracer, initWebTelemetry }
export type { InitConsentedTelemetryOptions, TelemetryTags } from './consented.ts'
export { consentedTelemetryLayer, initConsentedTelemetry, setFhirServerHost } from './consented.ts'
export type { InitSentryWebOptions } from './sentry.ts'
export { initSentryWeb, Sentry } from './sentry.ts'
